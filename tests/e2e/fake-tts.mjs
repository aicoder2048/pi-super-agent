// Stands in for edge-tts in the e2e tests (PSA_TTS_COMMAND): same arguments, appends each text to PSA_TTS_LOG as one JSON line,
// and writes 0.8 s of silent WAV, long enough for a test to pause and resume it. Takes 300 ms, like a quick synthesis.
import { appendFileSync, writeFileSync } from "node:fs";

const arg = (name) => process.argv[process.argv.indexOf(name) + 1];
const rate = 8000;
const samples = Math.round(rate * 0.8);
const wav = Buffer.alloc(44 + samples);
wav.write("RIFF", 0);
wav.writeUInt32LE(36 + samples, 4);
wav.write("WAVEfmt ", 8);
wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20);
wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(rate, 24);
wav.writeUInt32LE(rate, 28);
wav.writeUInt16LE(1, 32);
wav.writeUInt16LE(8, 34);
wav.write("data", 36);
wav.writeUInt32LE(samples, 40);
wav.fill(128, 44);
await new Promise((done) => setTimeout(done, 300));
appendFileSync(process.env.PSA_TTS_LOG, `${JSON.stringify(arg("--text"))}\n`);
writeFileSync(arg("--write-media"), wav);
