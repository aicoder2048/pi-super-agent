/** Read-only preview; the lead alone appends the returned facts with the existing data tool. */
import { readFileSync } from "node:fs";
import { importBrokerCsv, type BrokerImportInput } from "../../broker-import.ts";
import { readCollections } from "../../data-db.ts";

export { importBrokerCsv } from "../../broker-import.ts";

/** `fetched` is the file the user uploaded on the web page (host fetch `upload.file`); `csv` text is only for the tool's cases. */
type Input = Pick<BrokerImportInput, "broker" | "import_date"> & { csv?: string; upload_id?: string; fetched?: { file: string; filename: string; size: number } };

export default function preview({ fetched, csv, upload_id: _, ...input }: Input) {
	const text = fetched ? readFileSync(fetched.file, "utf8") : csv;
	const result = importBrokerCsv({ ...input, csv: text as string, ...readCollections(["fills", "accounts"]) });
	return fetched ? { ...result, file: { name: fetched.filename, size: fetched.size } } : result;
}
