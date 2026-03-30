import { createMockFetch } from "@luxass/msw-utils";
import { setupServer } from "msw/node";

export const GITHUB_API_BASE = "https://api.github.com";
export const NPM_REGISTRY = "https://registry.npmjs.org";

export const server = setupServer();

export const mockFetch = createMockFetch({ mswServer: server });
