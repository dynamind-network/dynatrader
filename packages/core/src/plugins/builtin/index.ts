import { registerBuiltinPlugin } from '../composition';
import { createExchangePlugin } from './exchange-plugin';
import { createWalletPlugin } from './wallet-plugin';

registerBuiltinPlugin('exchange', createExchangePlugin);
registerBuiltinPlugin('wallet', createWalletPlugin);

export { createExchangePlugin } from './exchange-plugin';
export { createWalletPlugin } from './wallet-plugin';
