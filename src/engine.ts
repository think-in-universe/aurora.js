/* This is free and unencumbered software released into the public domain. */

import { AccountID, Address } from './account.js';
import {
  BlockHash,
  BlockHeight,
  BlockID,
  BlockOptions,
  BlockProxy,
  parseBlockID,
} from './block.js';
import { NETWORKS } from './config.js';
import { KeyStore } from './key_store.js';
import { Err, Ok, Quantity, Result, U256 } from './prelude.js';
import {
  SubmitResult,
  FunctionCallArgs,
  GetStorageAtArgs,
  InitCallArgs,
  NewCallArgs,
  ViewCallArgs,
  FungibleTokenMetadata,
  TransactionStatus,
  OutOfGas,
  GasBurned,
  WrappedSubmitResult,
} from './schema.js';
import { TransactionID } from './transaction.js';

import { base58ToBytes } from './utils.js';
import { defaultAbiCoder } from '@ethersproject/abi';
import { arrayify as parseHexString } from '@ethersproject/bytes';
import { parse as parseRawTransaction } from '@ethersproject/transactions';
import { toBigIntBE, toBufferBE } from 'bigint-buffer';
import { Buffer } from 'buffer';
import BN from 'bn.js';
import * as NEAR from 'near-api-js';
import { ResErr } from '@hqoss/monads/dist/lib/result/result';

export { getAddress as parseAddress } from '@ethersproject/address';
export { arrayify as parseHexString } from '@ethersproject/bytes';

export type Bytecode = Uint8Array;
export type Bytecodeish = Bytecode | string;
export type ChainID = bigint;
export type Error = string;

export interface TransactionOutcome {
  id: TransactionID;
  output: Uint8Array;
  gasBurned?: GasBurned;
  tx?: string;
}

export interface BlockInfo {
  hash: BlockHash;
  coinbase: Address;
  timestamp: number;
  number: BlockHeight;
  difficulty: number;
  gasLimit: Quantity;
}

export interface ViewOptions {
  block?: BlockID;
}

export interface ConnectOptions {
  network?: string; // network ID
  endpoint?: string; // endpoint URL
  contract?: string; // engine ID
  signer?: string; // signer ID
}

export interface ConnectEnv {
  AURORA_ENGINE?: string; // engine ID
  HOME?: string; // home directory
  NEAR_ENV?: string; // network ID
  NEAR_MASTER_ACCOUNT?: string; // signer ID
  NEAR_URL?: string; // endpoint URL
}

export type AddressStorage = Map<U256, U256>;

export class AddressState {
  constructor(
    public address: Address,
    public nonce: U256 = BigInt(0),
    public balance: Quantity = BigInt(0),
    public code?: Bytecode,
    public storage: AddressStorage = new Map()
  ) {}
}

export const enum EngineStorageKeyPrefix {
  Config = 0x0,
  Nonce = 0x1,
  Balance = 0x2,
  Code = 0x3,
  Storage = 0x4,
}

export type EngineStorage = Map<Address, AddressState>;

export class EngineState {
  constructor(public storage: EngineStorage = new Map()) {}
}

export interface TransactionErrorDetails {
  tx?: string;
  gasBurned?: GasBurned;
}

const DEFAULT_NETWORK_ID = 'local';

export class Engine {
  protected constructor(
    public readonly near: NEAR.Near,
    public readonly keyStore: KeyStore,
    public readonly signer: NEAR.Account,
    public readonly networkID: string,
    public readonly contractID: AccountID
  ) {}

  static async connect(
    options: ConnectOptions,
    env?: ConnectEnv
  ): Promise<Engine> {
    const networkID =
      options.network || (env && env.NEAR_ENV) || DEFAULT_NETWORK_ID;
    const network = NETWORKS.get(networkID)!; // TODO: error handling
    const contractID = AccountID.parse(
      options.contract || (env && env.AURORA_ENGINE) || network.contractID
    ).unwrap();
    const signerID = AccountID.parse(
      options.signer || (env && env.NEAR_MASTER_ACCOUNT)
    ).unwrap(); // TODO: error handling

    const keyStore = KeyStore.load(networkID, env);
    const near = new NEAR.Near({
      deps: { keyStore },
      networkId: networkID,
      nodeUrl:
        options.endpoint || (env && env.NEAR_URL) || network.nearEndpoint,
    });
    const signer = await near.account(signerID.toString());
    return new Engine(near, keyStore, signer, networkID, contractID);
  }

  async install(contractCode: Bytecode): Promise<Result<TransactionID, Error>> {
    const contractAccount = (await this.getAccount()).unwrap();
    const result = await contractAccount.deployContract(contractCode);
    return Ok(TransactionID.fromHex(result.transaction.hash));
  }

  async upgrade(contractCode: Bytecode): Promise<Result<TransactionID, Error>> {
    return await this.install(contractCode);
  }

  async initialize(options: any): Promise<Result<TransactionID, Error>> {
    const newArgs = new NewCallArgs(
      parseHexString(defaultAbiCoder.encode(['uint256'], [options.chain || 0])),
      options.owner || '',
      options.bridgeProver || '',
      new BN(options.upgradeDelay || 0)
    );
    const default_ft_metadata = FungibleTokenMetadata.default();
    const given_ft_metadata = options.metadata || default_ft_metadata;
    const ft_metadata = new FungibleTokenMetadata(
      given_ft_metadata.spec || default_ft_metadata.spec,
      given_ft_metadata.name || default_ft_metadata.name,
      given_ft_metadata.symbol || default_ft_metadata.symbol,
      given_ft_metadata.icon || default_ft_metadata.icon,
      given_ft_metadata.reference || default_ft_metadata.reference,
      given_ft_metadata.reference_hash || default_ft_metadata.reference_hash,
      given_ft_metadata.decimals || default_ft_metadata.decimals
    );
    // default values are the testnet values
    const connectorArgs = new InitCallArgs(
      options.prover || 'prover.ropsten.testnet',
      options.ethCustodian || '9006a6D7d08A388Eeea0112cc1b6b6B15a4289AF',
      ft_metadata
    );

    // TODO: this should be able to be a single transaction with multiple actions,
    // but there doesn't seem to be a good way to do that in `near-api-js` presently.
    const tx = await this.promiseAndThen(
      this.callMutativeFunction('new', newArgs.encode()),
      (_) =>
        this.callMutativeFunction('new_eth_connector', connectorArgs.encode())
    );

    return tx.map(({ id }) => id);
  }

  // Like Result.andThen, but wrapped up in Promises
  private async promiseAndThen<T, U, E>(
    p: Promise<Result<T, E>>,
    f: (x: T) => Promise<Result<U, E>>
  ): Promise<Result<U, E>> {
    const r = await p;
    if (r.isOk()) {
      const t = r.unwrap();
      return await f(t);
    } else {
      return Err(r.unwrapErr());
    }
  }

  async getAccount(): Promise<Result<NEAR.Account, Error>> {
    return Ok(await this.near.account(this.contractID.toString()));
  }

  async getBlockHash(): Promise<Result<BlockHash, Error>> {
    const contractAccount = (await this.getAccount()).unwrap();
    const state = (await contractAccount.state()) as any;
    return Ok(state.block_hash);
  }

  async getBlockHeight(): Promise<Result<BlockHeight, Error>> {
    const contractAccount = (await this.getAccount()).unwrap();
    const state = (await contractAccount.state()) as any;
    return Ok(state.block_height);
  }

  async getBlockInfo(): Promise<Result<BlockInfo, Error>> {
    return Ok({
      hash: '', // TODO
      coinbase: Address.zero(), // TODO
      timestamp: 0,
      number: 0,
      difficulty: 0,
      gasLimit: 0,
    });
  }

  async getBlockTransactionCount(
    blockID: BlockID
  ): Promise<Result<number, Error>> {
    try {
      const provider = this.near.connection.provider;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const block = (await provider.block(parseBlockID(blockID))) as any;

      const chunk_mask: boolean[] = block.header.chunk_mask;

      const requests = (block.chunks as any[])
        .filter((_: any, index) => chunk_mask[index])
        .map(async (chunkHeader: any) => {
          if (chunkHeader.tx_root == '11111111111111111111111111111111') {
            return 0; // no transactions in this chunk
          } else {
            const chunk = await provider.chunk(chunkHeader.chunk_hash);
            return chunk.transactions.length;
          }
        });

      const counts = (await Promise.all(requests)) as number[];
      return Ok(counts.reduce((a, b) => a + b, 0));
    } catch (error: any) {
      //console.error('Engine#getBlockTransactionCount', error);
      return Err(error.message);
    }
  }

  async getBlock(
    blockID: BlockID,
    options?: BlockOptions
  ): Promise<Result<BlockProxy, Error>> {
    const provider = this.near.connection.provider;
    return await BlockProxy.fetch(provider, blockID, options);
  }

  async hasBlock(blockID: BlockID): Promise<Result<boolean, Error>> {
    const provider = this.near.connection.provider;
    return await BlockProxy.lookup(provider, blockID);
  }

  async getCoinbase(): Promise<Result<Address, Error>> {
    return Ok(Address.zero()); // TODO
  }

  async getVersion(options?: ViewOptions): Promise<Result<string, Error>> {
    return (
      await this.callFunction('get_version', undefined, options)
    ).map((output) => output.toString());
  }

  async getOwner(options?: ViewOptions): Promise<Result<AccountID, Error>> {
    return (
      await this.callFunction('get_owner', undefined, options)
    ).andThen((output) => AccountID.parse(output.toString()));
  }

  async getBridgeProvider(
    options?: ViewOptions
  ): Promise<Result<AccountID, Error>> {
    return (
      await this.callFunction('get_bridge_provider', undefined, options)
    ).andThen((output) => AccountID.parse(output.toString()));
  }

  async getChainID(options?: ViewOptions): Promise<Result<ChainID, Error>> {
    const result = await this.callFunction('get_chain_id', undefined, options);
    return result.map(toBigIntBE);
  }

  // TODO: getUpgradeIndex()
  // TODO: stageUpgrade()
  // TODO: deployUpgrade()

  async deployCode(bytecode: Bytecodeish): Promise<Result<Address, Error>> {
    const args = parseHexString(bytecode);
    const outcome = await this.callMutativeFunction('deploy_code', args);
    return outcome.map(({ output }) => {
      const result = SubmitResult.decode(Buffer.from(output));
      return Address.parse(
        Buffer.from(result.output().unwrap()).toString('hex')
      ).unwrap();
    });
  }

  async call(
    contract: Address,
    input: Uint8Array | string
  ): Promise<Result<Uint8Array, Error>> {
    const args = new FunctionCallArgs(
      contract.toBytes(),
      this.prepareInput(input)
    );
    return (await this.callMutativeFunction('call', args.encode())).map(
      ({ output }) => output
    );
  }

  async submit(
    input: Uint8Array | string
  ): Promise<Result<WrappedSubmitResult, Error>> {
    try {
      const inputBytes = this.prepareInput(input);
      try {
        const rawTransaction = parseRawTransaction(inputBytes); // throws Error
        if (rawTransaction.gasLimit.toBigInt() < 21000n) {
          // See: https://github.com/aurora-is-near/aurora-relayer/issues/17
          return Err('ERR_INTRINSIC_GAS');
        }
      } catch (error) {
        //console.error(error); // DEBUG
        return Err('ERR_INVALID_TX');
      }
      return (await this.callMutativeFunction('submit', inputBytes)).map(
        ({ output, gasBurned, tx }) => {
          return new WrappedSubmitResult(
            SubmitResult.decode(Buffer.from(output)),
            gasBurned,
            tx
          );
        }
      );
    } catch (error) {
      //console.error(error); // DEBUG
      return Err(error.message);
    }
  }

  // TODO: metaCall()

  async view(
    sender: Address,
    address: Address,
    amount: Quantity,
    input: Uint8Array | string,
    options?: ViewOptions
  ): Promise<Result<Uint8Array | ResErr<unknown, OutOfGas>, Error>> {
    const args = new ViewCallArgs(
      sender.toBytes(),
      address.toBytes(),
      toBufferBE(BigInt(amount), 32),
      this.prepareInput(input)
    );
    const result = await this.callFunction('view', args.encode(), options);
    return result.map((output) => {
      const status = TransactionStatus.decode(output);
      if (status.success !== undefined)
        return status.success.output as Uint8Array;
      else if (status.revert !== undefined)
        return status.revert.output as Uint8Array;
      else if (status.outOfGas !== undefined) return Err(status.outOfGas);
      else if (status.outOfFund !== undefined) return Err(status.outOfFund);
      else if (status.outOfOffset !== undefined) return Err(status.outOfOffset);
      else if (status.callTooDeep !== undefined) return Err(status.callTooDeep);
      else return Err('Failed to retrieve data from the contract');
    });
  }

  async getCode(
    address: Address,
    options?: ViewOptions
  ): Promise<Result<Bytecode, Error>> {
    const args = address.toBytes();
    if (typeof options === 'object' && options.block) {
      options.block = ((options.block as number) + 1) as BlockID;
    }
    return await this.callFunction('get_code', args, options);
  }

  async getBalance(
    address: Address,
    options?: ViewOptions
  ): Promise<Result<U256, Error>> {
    const args = address.toBytes();
    const result = await this.callFunction('get_balance', args, options);
    return result.map(toBigIntBE);
  }

  async getNonce(
    address: Address,
    options?: ViewOptions
  ): Promise<Result<U256, Error>> {
    const args = address.toBytes();
    const result = await this.callFunction('get_nonce', args, options);
    return result.map(toBigIntBE);
  }

  async getStorageAt(
    address: Address,
    key: U256 | number | string,
    options?: ViewOptions
  ): Promise<Result<U256, Error>> {
    const args = new GetStorageAtArgs(
      address.toBytes(),
      parseHexString(defaultAbiCoder.encode(['uint256'], [key]))
    );
    const result = await this.callFunction(
      'get_storage_at',
      args.encode(),
      options
    );
    return result.map(toBigIntBE);
  }

  async getAuroraErc20Address(
    nep141: AccountID,
    options?: ViewOptions
  ): Promise<Result<Address, Error>> {
    const args = Buffer.from(nep141.id, 'utf-8');

    const result = await this.callFunction(
      'get_erc20_from_nep141',
      args,
      options
    );

    return result.map((output) => {
      return Address.parse(output.toString('hex')).unwrap();
    });
  }

  async getNEP141Account(
    erc20: Address,
    options?: ViewOptions
  ): Promise<Result<AccountID, Error>> {
    const args = erc20.toBytes();

    const result = await this.callFunction(
      'get_nep141_from_erc20',
      args,
      options
    );

    return result.map((output) => {
      return AccountID.parse(output.toString('utf-8')).unwrap();
    });
  }

  // TODO: beginChain()
  // TODO: beginBlock()

  async getStorage(): Promise<Result<EngineStorage, Error>> {
    const result = new Map();
    const contractAccount = (await this.getAccount()).unwrap();
    const records = await contractAccount.viewState('', { finality: 'final' });
    for (const record of records) {
      const record_type = record.key[0];
      if (record_type == EngineStorageKeyPrefix.Config) continue; // skip EVM metadata

      const key =
        record_type == EngineStorageKeyPrefix.Storage
          ? record.key.subarray(1, 21)
          : record.key.subarray(1);
      const address = Buffer.from(key).toString('hex');

      if (!result.has(address)) {
        result.set(address, new AddressState(Address.parse(address).unwrap()));
      }

      const state = result.get(address)!;
      switch (record_type) {
        case EngineStorageKeyPrefix.Config:
          break; // unreachable
        case EngineStorageKeyPrefix.Nonce:
          state.nonce = toBigIntBE(record.value);
          break;
        case EngineStorageKeyPrefix.Balance:
          state.balance = toBigIntBE(record.value);
          break;
        case EngineStorageKeyPrefix.Code:
          state.code = record.value;
          break;
        case EngineStorageKeyPrefix.Storage: {
          state.storage.set(
            toBigIntBE(record.key.subarray(21)),
            toBigIntBE(record.value)
          );
          break;
        }
      }
    }
    return Ok(result);
  }

  protected async callFunction(
    methodName: string,
    args?: Uint8Array,
    options?: ViewOptions
  ): Promise<Result<Buffer, Error>> {
    const result = await this.signer.connection.provider.query({
      request_type: 'call_function',
      account_id: this.contractID.toString(),
      method_name: methodName,
      args_base64: this.prepareInput(args).toString('base64'),
      finality:
        options?.block === undefined || options?.block === null
          ? 'final'
          : undefined,
      block_id:
        options?.block !== undefined && options?.block !== null
          ? options.block
          : undefined,
    });
    if (result.logs && result.logs.length > 0) console.debug(result.logs); // TODO
    return Ok(Buffer.from(result.result));
  }

  protected async callMutativeFunction(
    methodName: string,
    args?: Uint8Array
  ): Promise<Result<TransactionOutcome, Error>> {
    this.keyStore.reKey();
    const gas = new BN('300000000000000'); // TODO?
    try {
      const result = await this.signer.functionCall(
        this.contractID.toString(),
        methodName,
        this.prepareInput(args),
        gas
      );
      if (
        typeof result.status === 'object' &&
        typeof result.status.SuccessValue === 'string'
      ) {
        const transactionId = result?.transaction_outcome?.id;
        return Ok({
          id: TransactionID.fromHex(result.transaction.hash),
          output: Buffer.from(result.status.SuccessValue, 'base64'),
          tx: transactionId,
          gasBurned: await this.transactionGasBurned(transactionId),
        });
      }
      return Err(result.toString()); // FIXME: unreachable?
    } catch (error) {
      //assert(error instanceof ServerTransactionError);
      switch (error?.type) {
        case 'FunctionCallError': {
          const transactionId = error?.transaction_outcome?.id;
          const details: TransactionErrorDetails = {
            tx: transactionId,
            gasBurned: await this.transactionGasBurned(transactionId),
          };
          const errorKind = error?.kind?.ExecutionError;
          if (errorKind) {
            const errorCode = errorKind.replace(
              'Smart contract panicked: ',
              ''
            );
            return Err(this.errorWithDetails(errorCode, details));
          }
          return Err(this.errorWithDetails(error.message, details));
        }
        case 'MethodNotFound':
          return Err(error.message);
        default:
          console.debug(error);
          return Err(error.toString());
      }
    }
  }

  private prepareInput(args?: Uint8Array | string): Buffer {
    if (typeof args === 'undefined') return Buffer.alloc(0);
    if (typeof args === 'string')
      return Buffer.from(parseHexString(args as string));
    return Buffer.from(args);
  }

  private errorWithDetails(
    message: string,
    details: TransactionErrorDetails
  ): string {
    return `${message}|${JSON.stringify(details)}`;
  }

  private async transactionGasBurned(id: string): Promise<GasBurned> {
    try {
      const transactionStatus = await this.near.connection.provider.txStatus(
        base58ToBytes(id),
        this.contractID.toString()
      );
      const receiptsGasBurned = transactionStatus.receipts_outcome.reduce(
        (sum, value) => sum + value.outcome.gas_burnt,
        0
      );
      const transactionGasBurned =
        transactionStatus.transaction_outcome.outcome.gas_burnt || 0;
      return receiptsGasBurned + transactionGasBurned;
    } catch (error) {
      return 0;
    }
  }
}
