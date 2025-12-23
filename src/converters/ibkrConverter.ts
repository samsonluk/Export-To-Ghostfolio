import dayjs from "dayjs";
import { parse } from "csv-parse";
import { IbkrRecord } from "../models/ibkrRecord";
import { AbstractConverter } from "./abstractconverter";
import { IbkrTradeRecord } from "../models/ibkrTradeRecord";
import { SecurityService } from "../securityService";
import { GhostfolioExport } from "../models/ghostfolioExport";
import YahooFinanceRecord from "../models/yahooFinanceRecord";
import { IbkrDividendRecord } from "../models/ibkrDividendRecord";
import { GhostfolioActivity } from "../models/ghostfolioActivity";
import { GhostfolioOrderType } from "../models/ghostfolioOrderType";

export class IbkrConverter extends AbstractConverter {

    private isinOverrides: Map<string, string> = new Map();
    private manualIsins: Set<string> = new Set();

    constructor(securityService: SecurityService) {
        super(securityService);
        this.loadIsinOverrides();
    }

    /**
     * @inheritdoc
     */
    public processFileContents(input: string, successCallback: any, errorCallback: any): void {

        // Parse the CSV and convert to Ghostfolio import format.
        parse(input, {
            delimiter: ",",
            fromLine: 2,
            columns: this.processHeaders(input),
            cast: (columnValue, context) => {

                // Custom mapping below.

                // Convert actions to Ghostfolio type.
                if (context.column === "type") {
                    const action = columnValue.toLocaleLowerCase();

                    if (action.indexOf("buy") > -1) {
                        return "buy";
                    }
                    else if (action.indexOf("sell") > -1) {
                        return "sell";
                    }
                    else if (action.indexOf("dividend") > -1) {
                        return "dividend";
                    }
                    else if (action.indexOf("tax") > -1) {
                        return "dividendTax";
                    }
                }

                // Parse numbers to floats (from string).
                if (context.column === "amount" ||
                    context.column === "quantity" ||
                    context.column === "price" ||
                    context.column === "totalAmount" ||
                    context.column === "commission") {

                    return Math.abs(parseFloat(columnValue));
                }

                return columnValue;
            }
        }, async (err, records: IbkrRecord[]) => {

            try {

                // Check if parsing failed..
                if (err || records === undefined || records.length === 0) {
                    let errorMsg = "An error occurred while parsing!";

                    if (err) {
                        errorMsg += ` Details: ${err.message}`
                    }

                    return errorCallback(new Error(errorMsg))
                }

                console.log("[i] Read CSV file. Start processing..");
                const result: GhostfolioExport = {
                    meta: {
                        date: new Date(),
                        version: "v0"
                    },
                    activities: []
                }

                // Populate the progress bar.
                const bar1 = this.progress.create(records.length, 0);

                for (let idx = 0; idx < records.length; idx++) {
                    const record = records[idx];

                    // Check if the record should be ignored.
                    if (this.isIgnoredRecord(record)) {

                        bar1.increment();
                        continue;
                    }

                    let currency = "";
                    if ((record as IbkrDividendRecord).currency) {
                        currency = (record as IbkrDividendRecord).currency;
                    } else {
                        currency = (record as IbkrTradeRecord).tradeCurrency;
                    }
                    currency === "GBX" ? currency = "GBp" : currency;

                    let security: YahooFinanceRecord;
                    let dataSource = "YAHOO";
                    
                    try {
                        // Check for ISIN overrides
                        if (this.isManualIsin(record.isin)) {
                            // Manual ISIN - create mock security record
                            security = {
                                symbol: `GF_${record.isin}`,
                                currency: currency || 'USD',
                                name: record.isin
                            } as YahooFinanceRecord;
                            dataSource = "MANUAL";
                        } else {
                            const symbolOverride = this.getSymbolOverride(record.isin);
                            
                            if (symbolOverride) {
                                // Use override symbol for Yahoo lookup
                                security = await this.securityService.getSecurity(
                                    null,
                                    symbolOverride,
                                    null,
                                    currency,
                                    this.progress);
                            } else {
                                // Normal Yahoo lookup
                                security = await this.securityService.getSecurity(
                                    record.isin,
                                    null,
                                    null,
                                    currency,
                                    this.progress);
                            }
                        }
                    }
                    catch (err) {
                        this.logQueryError(record.isin, idx + 2);
                        return errorCallback(err);
                    }

                    // Log whenever there was no match found.
                    if (!security) {
                        this.progress.log(`[i] No result found for ${record.type} action for ${record.isin}! Please add this manually..\n`);
                        bar1.increment();
                        continue;
                    }

                    const date = dayjs(`${record.date}`, "YYYYMMDD");

                    let fees = 0, quantity = 0, price = 0;
                    let type = GhostfolioOrderType.buy;
                    let comment = "";

                    if ((record as IbkrDividendRecord).currency) {
                        const dividendRecord = record as IbkrDividendRecord;

                        // Check for PIL (cash credit or debit made to an account in recognition of a cash dividend paid to stockholders of the issuer).
                        if (dividendRecord.description.toLocaleLowerCase().indexOf("in lieu of") > -1) {

                            quantity = dividendRecord.amount;
                            comment = dividendRecord.description;
                            type = GhostfolioOrderType.dividend;
                        }
                        else {

                            // For regular dividends, parse the amount and price.
                            price = parseFloat(dividendRecord.description.match(/(\d+(\.\d+)?)(?= PER SHARE)/)[0]);;

                            if (dividendRecord.type === "dividendTax") {
                                fees = Math.abs(dividendRecord.amount);
                            } else {
                                quantity = parseFloat((dividendRecord.amount / price).toFixed(3));
                            }

                            comment = dividendRecord.description;
                            type = GhostfolioOrderType.dividend;

                            let existingDividendRecord = this.findExactDividendMatch(dividendRecord, security.symbol, result.activities);

                            // When a match was found, that data entry should be completed.
                            if (existingDividendRecord) {

                                // Existing record is tax record. Should be overwritten.
                                if (existingDividendRecord.comment.indexOf("TAX") > -1) {
                                    existingDividendRecord.comment = comment;
                                    existingDividendRecord.unitPrice = price;
                                    existingDividendRecord.quantity = quantity;

                                }
                                else {

                                    // Existing record is dividend record. Add tax info.
                                    existingDividendRecord.fee = fees;
                                }

                                // Mark completed and move to next entry.
                                bar1.increment();
                                continue;
                            }
                        }
                    }
                    else {
                        const tradeRecord = record as IbkrTradeRecord;

                        fees = tradeRecord.commission;
                        quantity = tradeRecord.quantity;
                        price = tradeRecord.price;
                        type = GhostfolioOrderType[tradeRecord.type]
                    }

                    result.activities.push({
                        accountId: process.env.GHOSTFOLIO_ACCOUNT_ID,
                        comment: comment,
                        fee: fees,
                        quantity: quantity,
                        type: type,
                        unitPrice: price,
                        currency: currency,
                        dataSource: dataSource,
                        date: date.format("YYYY-MM-DDTHH:mm:ssZ"),
                        symbol: security.symbol
                    });

                    bar1.increment();
                }

                this.progress.stop();
                successCallback(result);
            }
            catch (error) {
                console.log("[e] An error occurred while processing the file contents. Stack trace:");
                console.log(error.stack);
                this.progress.stop();
                errorCallback(error);
            }
        });
    }

    /**
     * @inheritdoc
     */
    protected processHeaders(input: string, splitChar = ","): string[] {

        const firstLine = input.split('\n')[0];
        const colsInFile = firstLine.split(splitChar);

        // When more then 6 colums present, this is a Trades export.
        if (colsInFile.length > 6) {
            return [
                "type",
                "date",
                "isin",
                "quantity",
                "price",
                "totalAmount",
                "tradeCurrency",
                "commission",
                "commissionCurrency"];
        }

        // Otherwise it's a Dividend export.
        return [
            "type",
            "date",
            "isin",
            "description",
            "amount",
            "currency"];
    }

    /**
     * @inheritdoc
     */
    public isIgnoredRecord(record: IbkrRecord): boolean {

        return !record.isin;
    }

    private findExactDividendMatch(dividendRecord: IbkrDividendRecord, symbol: string, activities: GhostfolioActivity[]): GhostfolioActivity {

        return activities.find(a =>
            a.symbol === symbol &&
            a.currency === dividendRecord.currency &&
            a.comment.substring(0, 20) === dividendRecord.description.substring(0, 20) &&
            a.date === dayjs(dividendRecord.date).format("YYYY-MM-DDTHH:mm:ssZ"));
    }
        /**
     * Load ISIN overrides from isin-overrides.txt
     * Supports: ISIN=ISIN (MANUAL) or ISIN=YAHOO_SYMBOL (override)
     */
    private loadIsinOverrides(): void {
        const fs = require('fs');
        const path = require('path');
        const overridePath = path.join(process.cwd(), 'isin-overrides.txt');
        
        if (!fs.existsSync(overridePath)) {
            return;
        }

        const content = fs.readFileSync(overridePath, 'utf-8');
        const lines = content.split('\n');

        for (const line of lines) {
            const trimmed = line.trim();
            
            if (!trimmed || trimmed.startsWith('#')) {
                continue;
            }

            const parts = trimmed.split('=');
            if (parts.length !== 2) {
                continue;
            }

            const isin = parts[0].trim();
            const symbol = parts[1].trim();
            
            if (!isin || !symbol) {
                continue;
            }

            if (isin === symbol) {
                this.manualIsins.add(isin);
                console.log(`[IBKR] Marked ${isin} as MANUAL data source`);
            } else {
                this.isinOverrides.set(isin, symbol);
                console.log(`[IBKR] Override: ${isin} -> ${symbol}`);
            }
        }

        if (this.manualIsins.size > 0 || this.isinOverrides.size > 0) {
            console.log(`[IBKR] Loaded ${this.isinOverrides.size} overrides and ${this.manualIsins.size} manual ISINs`);
        }
    }

    /**
     * Check if an ISIN is marked as manual
     */
    private isManualIsin(isin: string): boolean {
        return this.manualIsins.has(isin);
    }

    /**
     * Get symbol with override support
     */
    private getSymbolOverride(isin: string): string | null {
        if (this.isinOverrides.has(isin)) {
            return this.isinOverrides.get(isin)!;
        }
        return null;
    }
}
