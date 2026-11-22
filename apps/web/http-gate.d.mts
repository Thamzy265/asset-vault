import type * as http from "node:http";

export declare const SUPPORTED_METHODS: string[];
export declare function guardRequests(listener: http.RequestListener, write?: (line: string) => void): http.RequestListener;
export declare function installRequestGuard(target: { createServer: typeof http.createServer }): void;
