import { AccountID, Address } from './account.js';
import NEAR, { NEARTransaction } from './near.js';
import { Option, U64, U256 } from './prelude.js';
import { SubmitResult } from './schema.js';
interface NEARFunctionCall {
    method_name: string;
    args: string;
    gas: number | string;
    deposit: number | string;
}
export declare class TransactionID {
    readonly id: string;
    protected constructor(id: string);
    static zero(): TransactionID;
    static fromHex(id: string): TransactionID;
    static fromBase58(id: string): TransactionID;
    toString(): string;
}
export declare class Transaction {
    readonly nonce: U256;
    readonly gasPrice: U256;
    readonly gasLimit: U256;
    readonly to: Option<Address>;
    readonly value: U256;
    readonly data: Uint8Array;
    readonly v?: U64;
    readonly r?: U256;
    readonly s?: U256;
    readonly from?: Address;
    readonly hash?: string;
    readonly result?: SubmitResult;
    readonly near?: NEARTransaction;
    constructor(nonce: U256, gasPrice: U256, gasLimit: U256, to: Option<Address>, value: U256, data: Uint8Array, v?: U64, r?: U256, s?: U256, from?: Address, hash?: string, result?: SubmitResult, near?: NEARTransaction);
    static fromOutcome(outcome: NEAR.providers.FinalExecutionOutcome, contractID?: AccountID): Option<Transaction>;
    static fromSubmitCall(outcome: NEAR.providers.FinalExecutionOutcome, functionCall: NEARFunctionCall): Option<Transaction>;
    isSigned(): boolean;
    toJSON(): any;
}
export {};
