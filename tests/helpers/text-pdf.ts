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
	return pdfOf(objects);
}

/** One page that draws a Form XObject, as merged or print-to-PDF files do. "image": the form draws a scanned image. "loop": the form names itself in its own resources and draws no image. */
export function formPdf(inside: "image" | "loop"): Buffer {
	const pixels = "\x80".repeat(64);
	const form = `q 612 0 0 792 0 0 cm /Im0 Do Q`;
	const innerXObject = inside === "image" ? "/Im0 5 0 R" : "/Fm0 4 0 R";
	const objects = [
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Fm0 4 0 R >> >> /Contents 6 0 R >>",
		`<< /Type /XObject /Subtype /Form /BBox [0 0 612 792] /Resources << /XObject << ${innerXObject} >> >> /Length ${form.length} >>\nstream\n${form}\nendstream`,
		`<< /Type /XObject /Subtype /Image /Width 8 /Height 8 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length ${pixels.length} >>\nstream\n${pixels}\nendstream`,
		"<< /Length 7 >>\nstream\n/Fm0 Do\nendstream",
	];
	return pdfOf(objects);
}

function pdfOf(objects: readonly string[]): Buffer {
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
