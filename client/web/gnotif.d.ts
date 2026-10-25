// Copied unchanged from gnotif (github.com/gfanton/gnotif, js/dist/gnotif.d.ts at 7833504); Apache-2.0.
/** A trigger as GET /v1/triggers returns it. */
export type Trigger = {
    id: string;
    /** realm path the event comes from */
    target: string;
    event: string;
    /** comma-separated key=value pairs, "" for none */
    filter: string;
    /** name of the parameter a user opts into, "" for none */
    param: string;
    title: string;
    body: string;
    link: string;
    /** address that declared the trigger */
    declarer: string;
    verified: boolean;
};
/** One trigger a browser asks to hear about, for one param value. */
export type Optin = {
    /** trigger id */
    trigger: string;
    /** the param value, "" for a trigger without a param */
    value: string;
    /**
     * false keeps the item off push: the page hears it live only. Push stays
     * on when absent.
     */
    push?: boolean | undefined;
};
/** A notification as either channel delivers it. */
export type GnotifNotification = {
    /** identifies the match; both channels carry the same one */
    id: string;
    /** the channel that delivered it first */
    source: "live" | "push";
    /** trigger id */
    trigger: string;
    /** the opted-in param value, "" for none */
    value: string;
    title: string;
    body: string;
    /** absolute URL on the page's origin */
    link: string;
    /** block height of the event */
    height: number;
    /** hash of the transaction that emitted the event */
    tx: string;
    /** the block's time, in UTC, as RFC 3339 */
    time: string;
    /** the event's attributes, in order */
    attrs: {
        key: string;
        value: string;
    }[];
};
/** What each event's handler receives. */
export type GnotifEvents = {
    /** a notification arrived, live or by push */
    notification: GnotifNotification;
    /** the live connection dropped and is retrying */
    reconnecting: undefined;
    /** it is back; notifications in between were missed */
    reconnect: undefined;
    /** a live failure no promise waits on */
    error: GnotifError;
};
export declare class GnotifError extends Error {
    status: number | undefined;
    code: "unsupported" | "denied" | "inactive" | "server" | "network";
    /** @param status HTTP status of the error answer a "server" error comes from */
    constructor(code: GnotifError["code"], message: string, status?: number);
}
/** @param s unpadded base64url text */
export declare function base64UrlToBytes(s: string): Uint8Array;
export declare function sameKey(a: ArrayBuffer | null | undefined, b: Uint8Array): boolean;
export declare class Gnotif {
    #private;
    constructor({ network, server, serviceWorker, icon, }?: {
        /** gno.land network whose hosted server to use, "onyx" by default; only a label when server is set */
        network?: string | undefined;
        /** base URL of another gnotif server, such as your own gnotifd */
        server?: string | undefined;
        /** URL of the dapp's copy of sw.js */
        serviceWorker?: string | undefined;
        /** URL of the image every notification shows, such as a PNG of the dapp's logo, relative to the page */
        icon?: string | undefined;
    });
    /** @returns the network named at construction */
    get network(): string | undefined;
    /** @returns base URL of the gnotif server this client calls */
    get server(): string;
    /**
     * @param target realm path whose verified triggers to list
     * @returns the triggers that realm offers
     */
    triggers(target: string): Promise<Trigger[]>;
    /**
     * Subscribes this browser and registers it with the server. Must run from
     * a user gesture: browsers refuse or hide a permission prompt otherwise.
     */
    enable(): Promise<PushSubscriptionJSON>;
    /**
     * Keeps optins as the set every channel uses, and sends it to the live
     * connection when one is open, and to the server for push when this
     * browser is subscribed, less the items with push: false. Resolves once
     * each has accepted its part.
     * @param optins replaces the previous set
     */
    setOptins(optins: Optin[]): Promise<void>;
    /**
     * Calls handler on every event of that name until the returned function
     * runs.
     * @returns removes the handler
     */
    on<K extends keyof GnotifEvents>(event: K, handler: (arg: GnotifEvents[K]) => void): () => void;
    /**
     * Opens the live connection with the kept set, and resolves once the
     * server accepts it. The set, address included, goes to the server:
     * call this when the user asks for live updates. After a drop the
     * connection comes back by itself, firing reconnecting and reconnect.
     */
    connect(): Promise<void>;
    /** Closes the live connection and stops reconnecting. */
    disconnect(): void;
    /**
     * Unsubscribes this browser first, then tells the server; a server that
     * no longer knows the subscription (404) is not an error.
     */
    disable(): Promise<void>;
    /**
     * Reports whether this browser holds a push subscription and still has
     * notification permission.
     */
    enabled(): Promise<boolean>;
}
