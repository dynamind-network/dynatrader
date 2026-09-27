import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { compareRuns, loadFixture, renderReport, replayFixture } from './index';

const fixtureDir = new URL('./fixtures/', import.meta.url);
const files = (await readdir(fixtureDir)).filter((name) => name.endsWith('.json')).sort();
const replays = await Promise.all(files.map(async (name) => {
  const value: unknown = JSON.parse(await readFile(new URL(name, fixtureDir), 'utf8'));
  return replayFixture(loadFixture(value));
}));
process.stdout.write(renderReport(compareRuns(replays)));
