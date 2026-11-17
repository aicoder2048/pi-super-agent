/** One rule for a US stock or ETF ticker across the tools, the feeds and recorded fills: BRK.B keeps its class dot. */
const TICKER = /^[A-Z][A-Z0-9]{0,5}(?:\.[A-Z])?$/;

export const isTicker = (symbol: string): boolean => TICKER.test(symbol);

/** The OCC option root of a ticker, without the class dot: BRK.B trades as BRKB. */
export const occRoot = (ticker: string): string => ticker.replaceAll(".", "");
