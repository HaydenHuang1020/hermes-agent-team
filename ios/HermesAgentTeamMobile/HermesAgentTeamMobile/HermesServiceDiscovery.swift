import Darwin
import Foundation

struct DiscoveredHermesService: Identifiable, Equatable {
  let id: String
  let name: String
  let host: String
  let port: Int
  let token: String

  var endpointText: String {
    "\(host):\(port)"
  }

  var tokenPreview: String {
    guard token.count > 8 else { return token.isEmpty ? "未提供" : token }
    return "\(token.prefix(4))...\(token.suffix(4))"
  }

  var baseURL: URL? {
    var components = URLComponents()
    components.scheme = "http"
    components.host = host
    components.port = port
    return components.url
  }
}

final class HermesServiceDiscovery: NSObject {
  var onUpdate: (([DiscoveredHermesService]) -> Void)?
  var onStateChange: ((Bool) -> Void)?

  private let browser = NetServiceBrowser()
  private var services: [String: NetService] = [:]
  private var resolvedServices: [String: DiscoveredHermesService] = [:]

  override init() {
    super.init()
    browser.delegate = self
  }

  func start() {
    browser.searchForServices(ofType: "_hat-team._tcp.", inDomain: "local.")
  }

  func stop() {
    browser.stop()
    services.values.forEach { $0.stop() }
    services.removeAll()
    resolvedServices.removeAll()
    publishUpdates()
    onStateChange?(false)
  }

  private func resolve(_ service: NetService) {
    services[service.name] = service
    service.delegate = self
    service.resolve(withTimeout: 5)
  }

  private func remove(_ service: NetService) {
    services[service.name]?.stop()
    services.removeValue(forKey: service.name)
    resolvedServices.removeValue(forKey: service.name)
    publishUpdates()
  }

  private func publishUpdates() {
    let sorted = resolvedServices.values.sorted { left, right in
      left.name.localizedStandardCompare(right.name) == .orderedAscending
    }
    onUpdate?(sorted)
  }

  private func resolvedHost(for service: NetService) -> String? {
    if let hostName = service.hostName?.trimmingCharacters(in: CharacterSet(charactersIn: ".")), !hostName.isEmpty {
      return hostName
    }
    let numericHosts = (service.addresses ?? []).compactMap(numericHost(from:))
    return numericHosts.first { !$0.contains(":") } ?? numericHosts.first
  }

  private func numericHost(from data: Data) -> String? {
    data.withUnsafeBytes { buffer -> String? in
      guard let baseAddress = buffer.baseAddress else { return nil }
      let socketAddress = baseAddress.assumingMemoryBound(to: sockaddr.self)
      var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
      let result = getnameinfo(
        socketAddress,
        socklen_t(data.count),
        &host,
        socklen_t(host.count),
        nil,
        0,
        NI_NUMERICHOST
      )
      guard result == 0 else { return nil }
      return String(cString: host)
    }
  }

  private func textValue(_ key: String, from record: [String: Data]) -> String {
    guard let data = record[key] else { return "" }
    return String(data: data, encoding: .utf8) ?? ""
  }

  private func preferredHost(resolvedHost: String, txtRecord: [String: Data]) -> String {
    let advertisedHost = textValue("host", from: txtRecord).trimmingCharacters(in: .whitespacesAndNewlines)
    return advertisedHost.isEmpty ? resolvedHost : advertisedHost
  }
}

extension HermesServiceDiscovery: NetServiceBrowserDelegate {
  func netServiceBrowserWillSearch(_ browser: NetServiceBrowser) {
    onStateChange?(true)
  }

  func netServiceBrowserDidStopSearch(_ browser: NetServiceBrowser) {
    onStateChange?(false)
  }

  func netServiceBrowser(_ browser: NetServiceBrowser, didNotSearch errorDict: [String: NSNumber]) {
    onStateChange?(false)
  }

  func netServiceBrowser(_ browser: NetServiceBrowser, didFind service: NetService, moreComing: Bool) {
    resolve(service)
  }

  func netServiceBrowser(_ browser: NetServiceBrowser, didRemove service: NetService, moreComing: Bool) {
    remove(service)
  }
}

extension HermesServiceDiscovery: NetServiceDelegate {
  func netServiceDidResolveAddress(_ sender: NetService) {
    guard let host = resolvedHost(for: sender), sender.port > 0 else { return }
    let txtRecord = NetService.dictionary(fromTXTRecord: sender.txtRecordData() ?? Data())
    let service = DiscoveredHermesService(
      id: sender.name,
      name: sender.name,
      host: preferredHost(resolvedHost: host, txtRecord: txtRecord),
      port: sender.port,
      token: textValue("token", from: txtRecord)
    )
    resolvedServices[sender.name] = service
    publishUpdates()
  }

  func netService(_ sender: NetService, didNotResolve errorDict: [String: NSNumber]) {
    resolvedServices.removeValue(forKey: sender.name)
    publishUpdates()
  }
}
