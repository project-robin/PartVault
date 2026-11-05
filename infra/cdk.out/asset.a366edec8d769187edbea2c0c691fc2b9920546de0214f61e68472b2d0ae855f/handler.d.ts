interface SQSMessage {
    messageId: string;
    body: string;
}
export declare const handler: (event: {
    Records: SQSMessage[];
}, context?: any) => Promise<{
    batchItemFailures: {
        itemIdentifier: string;
    }[];
}>;
export {};
//# sourceMappingURL=handler.d.ts.map