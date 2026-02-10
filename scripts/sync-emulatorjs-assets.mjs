import { cp, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, '..');

const emulatorDataSource = path.join(projectRoot, 'node_modules', '@emulatorjs', 'emulatorjs', 'data');
const n64CorePackages = [
  {
    packageName: 'core-parallel_n64',
    dataPrefix: 'parallel_n64',
  },
  {
    packageName: 'core-mupen64plus_next',
    dataPrefix: 'mupen64plus_next',
  },
];

const outputDataPath = path.join(projectRoot, 'public', 'emulatorjs', 'data');
const outputCoresPath = path.join(outputDataPath, 'cores');
const outputReportsPath = path.join(outputCoresPath, 'reports');

async function copyEmulatorData() {
  await mkdir(outputDataPath, { recursive: true });
  await cp(emulatorDataSource, outputDataPath, { recursive: true, force: true });
}

async function copyN64CoreData() {
  await mkdir(outputCoresPath, { recursive: true });
  await mkdir(outputReportsPath, { recursive: true });

  let copiedCoreCount = 0;

  for (const corePackage of n64CorePackages) {
    const coreSource = path.join(projectRoot, 'node_modules', '@emulatorjs', corePackage.packageName);
    const files = await readdir(coreSource, { withFileTypes: true });

    for (const file of files) {
      if (file.isFile() && file.name.startsWith(corePackage.dataPrefix) && file.name.endsWith('.data')) {
        await cp(path.join(coreSource, file.name), path.join(outputCoresPath, file.name), { force: true });
      }
    }

    const reportsPath = path.join(coreSource, 'reports');
    const reportFiles = await readdir(reportsPath, { withFileTypes: true });
    for (const reportFile of reportFiles) {
      if (reportFile.isFile() && reportFile.name.endsWith('.json')) {
        await cp(path.join(reportsPath, reportFile.name), path.join(outputReportsPath, reportFile.name), {
          force: true,
        });
      }
    }

    copiedCoreCount += 1;
  }

  if (copiedCoreCount === 0) {
    throw new Error('No N64 core packages were found in node_modules.');
  }
}

async function run() {
  await copyEmulatorData();
  await copyN64CoreData();
  console.log('Synced EmulatorJS assets to public/emulatorjs/data');
}

run().catch((error) => {
  console.error('Failed to sync EmulatorJS assets:', error);
  process.exitCode = 1;
});
