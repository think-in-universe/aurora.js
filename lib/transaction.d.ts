import { AccountID, Address } from './account.js';
import { Option, U64, U256 } from './prelude.js';
import NEAR from 'near-api-js';
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
    readonly v?: U64 | undefined;
    readonly r?: U256 | undefined;
    readonly s?: U256 | undefined;
    readonly from?: Address | undefined;
    readonly hash?: string | undefined;
    constructor(nonce: U256, gasPrice: U256, gasLimit: U256, to: Option<Address>, value: U256, data: Uint8Array, v?: U64 | undefined, r?: U256 | undefined, s?: U256 | undefined, from?: Address | undefined, hash?: string | undefined);
    static fromOutcome(outcome: NEAR.providers.FinalExecutionOutcome, contractID?: AccountID): Option<Transaction>;
    isSigned(): boolean;
    toJSON(): any;
}
