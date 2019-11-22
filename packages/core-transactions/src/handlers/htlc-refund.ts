import { Container, Contracts, Utils as AppUtils } from "@arkecosystem/core-kernel";
import { Enums, Interfaces, Managers, Transactions, Utils } from "@arkecosystem/crypto";
import assert from "assert";

import { HtlcLockNotExpiredError, HtlcLockTransactionNotFoundError } from "../errors";
import { HtlcLockTransactionHandler } from "./htlc-lock";
import { TransactionHandler, TransactionHandlerConstructor } from "./transaction";

@Container.injectable()
export class HtlcRefundTransactionHandler extends TransactionHandler {
    public getConstructor(): Transactions.TransactionConstructor {
        return Transactions.HtlcRefundTransaction;
    }

    public dependencies(): ReadonlyArray<TransactionHandlerConstructor> {
        return [HtlcLockTransactionHandler];
    }

    public walletAttributes(): ReadonlyArray<string> {
        return [];
    }

    public async bootstrap(): Promise<void> {
        const transactions = await this.transactionRepository.getRefundedHtlcLockBalances();

        for (const transaction of transactions) {
            AppUtils.assert.defined<string>(transaction.senderPublicKey);

            const refundWallet: Contracts.State.Wallet = this.walletRepository.findByPublicKey(
                transaction.senderPublicKey,
            ); // sender is from the original lock

            refundWallet.balance = refundWallet.balance.plus(transaction.amount);
        }
    }

    public async isActivated(): Promise<boolean> {
        return Managers.configManager.getMilestone().aip11 === true;
    }

    public dynamicFee(context: Contracts.Shared.DynamicFeeContext): Utils.BigNumber {
        // override dynamicFee calculation as this is a zero-fee transaction
        return Utils.BigNumber.ZERO;
    }

    public async throwIfCannotBeApplied(
        transaction: Interfaces.ITransaction,
        sender: Contracts.State.Wallet,
        customWalletRepository?: Contracts.State.WalletRepository,
    ): Promise<void> {
        await this.performGenericWalletChecks(transaction, sender, customWalletRepository);

        AppUtils.assert.defined<string>(transaction.data.asset?.refund);

        // Specific HTLC refund checks
        const walletRepository: Contracts.State.WalletRepository = customWalletRepository ?? this.walletRepository;

        AppUtils.assert.defined<Interfaces.IHtlcRefundAsset>(transaction.data.asset.refund);

        const lockId: string = transaction.data.asset.refund.lockTransactionId;
        const lockWallet: Contracts.State.Wallet = walletRepository.findByIndex(
            Contracts.State.WalletIndexes.Locks,
            lockId,
        );
        if (!lockWallet || !lockWallet.getAttribute("htlc.locks")[lockId]) {
            throw new HtlcLockTransactionNotFoundError();
        }

        const lock: Interfaces.IHtlcLock = lockWallet.getAttribute("htlc.locks", {})[lockId];
        const lastBlock: Interfaces.IBlock = this.app
            .get<Contracts.State.StateStore>(Container.Identifiers.StateStore)
            .getLastBlock();

        if (!AppUtils.expirationCalculator.calculateLockExpirationStatus(lastBlock, lock.expiration)) {
            throw new HtlcLockNotExpiredError();
        }
    }

    public async canEnterTransactionPool(
        data: Interfaces.ITransactionData,
        pool: Contracts.TransactionPool.Connection,
        processor: Contracts.TransactionPool.Processor,
    ): Promise<boolean> {
        AppUtils.assert.defined<string>(data.asset?.refund?.lockTransactionId);

        const lockId: string = data.asset.refund.lockTransactionId;

        const lockWallet: Contracts.State.Wallet = this.walletRepository.findByIndex(
            Contracts.State.WalletIndexes.Locks,
            lockId,
        );

        if (!lockWallet || !lockWallet.getAttribute("htlc.locks")[lockId]) {
            processor.pushError(
                data,
                "ERR_HTLCLOCKNOTFOUND",
                `The associated lock transaction id "${lockId}" was not found.`,
            );
            return false;
        }

        const htlcRefundsInpool: Interfaces.ITransactionData[] = Array.from(
            await pool.getTransactionsByType(Enums.TransactionType.HtlcRefund),
        ).map((memTx: Interfaces.ITransaction) => memTx.data);

        const alreadyHasPendingRefund: boolean = htlcRefundsInpool.some(transaction => {
            AppUtils.assert.defined<string>(transaction.asset?.claim?.lockTransactionId);

            return transaction.asset.claim.lockTransactionId === lockId;
        });

        if (alreadyHasPendingRefund) {
            processor.pushError(data, "ERR_PENDING", `HtlcRefund for "${lockId}" already in the pool`);
            return false;
        }

        return true;
    }

    public async applyToSender(
        transaction: Interfaces.ITransaction,
        customWalletRepository?: Contracts.State.WalletRepository,
    ): Promise<void> {
        const walletRepository: Contracts.State.WalletRepository = customWalletRepository ?? this.walletRepository;

        AppUtils.assert.defined<string>(transaction.data.senderPublicKey);

        const sender: Contracts.State.Wallet = walletRepository.findByPublicKey(transaction.data.senderPublicKey);

        const data: Interfaces.ITransactionData = transaction.data;

        if (Utils.isException(data.id)) {
            this.app.log.warning(`Transaction forcibly applied as an exception: ${transaction.id}.`);
        }

        await this.throwIfCannotBeApplied(transaction, sender, customWalletRepository);

        sender.verifyTransactionNonceApply(transaction);

        AppUtils.assert.defined<AppUtils.BigNumber>(data.nonce);

        sender.nonce = data.nonce;

        AppUtils.assert.defined<string>(data.asset?.refund?.lockTransactionId);

        const lockId: string = data.asset.refund.lockTransactionId;
        const lockWallet: Contracts.State.Wallet = walletRepository.findByIndex(
            Contracts.State.WalletIndexes.Locks,
            lockId,
        );

        assert(lockWallet && lockWallet.getAttribute("htlc.locks", {})[lockId]);

        const locks: Interfaces.IHtlcLocks = lockWallet.getAttribute("htlc.locks", {});
        const newBalance: Utils.BigNumber = lockWallet.balance.plus(locks[lockId].amount).minus(data.fee);
        assert(!newBalance.isNegative());

        lockWallet.balance = newBalance;
        const lockedBalance: Utils.BigNumber = lockWallet.getAttribute("htlc.lockedBalance", Utils.BigNumber.ZERO);

        const newLockedBalance: Utils.BigNumber = lockedBalance.minus(locks[lockId].amount);

        assert(!newLockedBalance.isNegative());
        lockWallet.setAttribute("htlc.lockedBalance", newLockedBalance);

        delete locks[lockId];

        walletRepository.reindex(lockWallet);
    }

    public async revertForSender(
        transaction: Interfaces.ITransaction,
        customWalletRepository?: Contracts.State.WalletRepository,
    ): Promise<void> {
        const walletRepository: Contracts.State.WalletRepository = customWalletRepository ?? this.walletRepository;

        AppUtils.assert.defined<string>(transaction.data.senderPublicKey);

        const sender: Contracts.State.Wallet = walletRepository.findByPublicKey(transaction.data.senderPublicKey);

        sender.verifyTransactionNonceRevert(transaction);

        sender.nonce = sender.nonce.minus(1);

        AppUtils.assert.defined<string>(transaction.data.asset?.refund?.lockTransactionId);

        const lockId: string = transaction.data.asset.refund.lockTransactionId;
        // @ts-ignore - Type 'Transaction' is not assignable to type 'ITransactionData'.
        const lockTransaction: Interfaces.ITransactionData = (await this.transactionRepository.findByIds([lockId]))[0];

        AppUtils.assert.defined<string>(lockTransaction.senderPublicKey);

        const lockWallet: Contracts.State.Wallet = walletRepository.findByPublicKey(lockTransaction.senderPublicKey);

        lockWallet.balance = lockWallet.balance.minus(lockTransaction.amount).plus(transaction.data.fee);

        const lockedBalance: Utils.BigNumber = lockWallet.getAttribute("htlc.lockedBalance");
        lockWallet.setAttribute("htlc.lockedBalance", lockedBalance.plus(lockTransaction.amount));

        const locks: Interfaces.IHtlcLocks | undefined = lockWallet.getAttribute("htlc.locks");

        AppUtils.assert.defined<Interfaces.IHtlcLockAsset>(lockTransaction.asset?.lock);

        if (locks) {
            AppUtils.assert.defined<string>(lockTransaction.id);

            locks[lockTransaction.id] = {
                amount: lockTransaction.amount,
                recipientId: lockTransaction.recipientId,
                timestamp: lockTransaction.timestamp,
                vendorField: lockTransaction.vendorField
                    ? Buffer.from(lockTransaction.vendorField, "hex").toString("utf8")
                    : undefined,
                ...lockTransaction.asset.lock,
            };
        }

        walletRepository.reindex(lockWallet);
    }

    public async applyToRecipient(
        transaction: Interfaces.ITransaction,
        customWalletRepository?: Contracts.State.WalletRepository,
    ): Promise<void> { }

    public async revertForRecipient(
        transaction: Interfaces.ITransaction,
        customWalletRepository?: Contracts.State.WalletRepository,
    ): Promise<void> { }
}
