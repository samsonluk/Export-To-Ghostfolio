import { GhostfolioOrderType } from "./ghostfolioOrderType";

export type DataSource = "YAHOO" | "MANUAL" | "COINGECKO" | "POLYGON" | "RAPID_API";

export class GhostfolioActivity {
    accountId: string;
    comment: string;
    fee: number;
    quantity: number;
    type: GhostfolioOrderType;
    unitPrice: number;
    currency: string;
    dataSource: DataSource;
    date: string;
    symbol: string;
}
