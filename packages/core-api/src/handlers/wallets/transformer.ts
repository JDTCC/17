import { Contracts } from "@arkecosystem/core-kernel";
import { Utils } from "@arkecosystem/crypto";

// todo: review the implementation
export const transformWallet = (wallet: Contracts.State.Wallet) => {
    const username: string = wallet.getAttribute("delegate.username");

    return {
        address: wallet.address,
        publicKey: wallet.publicKey,
        username,
        nonce: wallet.nonce.toFixed(),
        secondPublicKey: wallet.getAttribute("secondPublicKey"),
        balance: Utils.BigNumber.make(wallet.balance).toFixed(),
        isDelegate: !!username,
        vote: wallet.getAttribute("vote"),
    };
};
