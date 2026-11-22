import type * as http from "node:http";

export declare const SUPPORTED_METHODS: string[];
export declare function guardMethods(listener: http.RequestListener, write?: (line: string) => void): http.RequestListener;
export declare function installMethodGuard(target: { createServer: typeof http.createServer }): void;
