/** Read-only preview; the lead alone appends the returned facts with the existing data tool. */
import { importBrokerCsv, type BrokerImportInput } from "../../broker-import.ts";
import { readCollections } from "../../data-db.ts";

export { importBrokerCsv } from "../../broker-import.ts";
export default function preview(input: Pick<BrokerImportInput, "broker" | "csv" | "import_date">) {
 return importBrokerCsv({ ...input, ...readCollections(["fills", "accounts"]) });
}
