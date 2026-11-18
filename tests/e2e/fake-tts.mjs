// Stands in for edge-tts in the e2e tests (PSA_TTS_COMMAND): same arguments, appends each text to PSA_TTS_LOG as one JSON line,
// writes a few bytes as the "mp3", and takes 300 ms so the page's 停止 can be seen.
import { appendFileSync, writeFileSync } from "node:fs";

const arg = (name) => process.argv[process.argv.indexOf(name) + 1];
await new Promise((done) => setTimeout(done, 300));
appendFileSync(process.env.PSA_TTS_LOG, `${JSON.stringify(arg("--text"))}\n`);
writeFileSync(arg("--write-media"), "fake mp3");
