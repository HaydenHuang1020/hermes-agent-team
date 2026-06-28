import XCTest
@testable import HermesAgentTeamMobile

final class HermesAgentTeamMobileTests: XCTestCase {
  func testDesktopMobileLinkParsingExtractsBaseURLAndToken() throws {
    let settings = try AppModel.parseDesktopLink("http://192.168.1.208:18788/mobile?token=abc123")

    XCTAssertEqual(settings.serverBaseURL?.absoluteString, "http://192.168.1.208:18788")
    XCTAssertEqual(settings.token, "abc123")
  }

  func testNormalizedServerURLAddsHTTPWhenSchemeIsMissing() {
    XCTAssertEqual(AppModel.normalizedServerURL("192.168.1.208:18788")?.absoluteString, "http://192.168.1.208:18788")
  }

  func testCustomConnectionURLParsingExtractsServerAndToken() throws {
    let url = URL(string: "hermesagentteam://connect?server=http%3A%2F%2F192.168.1.208%3A18788&token=abc123")!
    let settings = try AppModel.parseConnectionURL(url)

    XCTAssertEqual(settings.serverBaseURL?.absoluteString, "http://192.168.1.208:18788")
    XCTAssertEqual(settings.token, "abc123")
  }
}
