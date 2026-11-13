/** A minimal PDF with one line of ASCII text per page, so a test can tell which pages were read. A Buffer is a page's content stream, already deflated. */
export function textPdf(pages: readonly (string | Buffer)[]): Buffer {
	const objects = [
		"<< /Type /Catalog /Pages 2 0 R >>",
		`<< /Type /Pages /Kids [${pages.map((_, i) => `${4 + 2 * i} 0 R`).join(" ")}] /Count ${pages.length} >>`,
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
		...pages.flatMap((text, i) => {
			const page = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + 2 * i} 0 R >>`;
			if (typeof text !== "string") return [page, `<< /Length ${text.length} /Filter /FlateDecode >>\nstream\n${text.toString("latin1")}\nendstream`];
			const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
			return [page, `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
		}),
	];
	let out = "%PDF-1.4\n";
	const offsets = objects.map((object, i) => {
		const at = out.length;
		out += `${i + 1} 0 obj\n${object}\nendobj\n`;
		return at;
	});
	const xref = out.length;
	out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
	out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
	return Buffer.from(out, "latin1");
}
