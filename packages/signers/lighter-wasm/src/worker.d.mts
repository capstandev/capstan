// Types for the plain-JS worker module (only its pure helpers are importable; the rest runs inside a Worker).
export declare function createOrderArgs(o: Record<string, unknown>): (number | boolean)[];
export declare function cancelArgs(a: Record<string, unknown>): number[];
