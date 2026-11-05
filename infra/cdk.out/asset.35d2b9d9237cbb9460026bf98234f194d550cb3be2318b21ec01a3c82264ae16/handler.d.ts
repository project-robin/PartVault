export declare const handler: (event: any, context?: any) => Promise<{
    statusCode: number;
    headers: {
        "Content-Type": string;
        "Access-Control-Allow-Origin": string;
    };
    body: string;
} | {
    statusCode: number;
    headers: {
        "Content-Type": string;
        "Content-Disposition": string;
        "Access-Control-Allow-Origin": string;
    };
    body: string;
}>;
//# sourceMappingURL=handler.d.ts.map