import type { HermesTeamApi } from "./types";

declare global {
  interface Window {
    hermesTeam?: HermesTeamApi;
  }
}

export {};
