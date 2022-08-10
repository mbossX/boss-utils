/**
 * MIT License
 *
 * Copyright (c) 2022 asledgehammer
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

/**
 * Compiler.ts - For compiling TypeScript files to Lua files using TypeScriptToLua.
 * (Designed for the Project Zomboid environment)
 *
 * @author JabDoesThings
 */

const ansi = require('ansi');
const cursor = ansi(process.stdout);

import * as child_process from 'child_process';
import * as fs from 'fs';
import * as chokidar from 'chokidar';
import { transpileProject } from 'typescript-to-lua';

type Scope = 'client' | 'server' | 'shared' | 'none';

let PREFIX = '[COMPILER]';
let LUA_HEADER_FILE = '';
if (fs.existsSync('./scripts/header.txt'))
  LUA_HEADER_FILE = fs.readFileSync('./scripts/header.txt').toString();
let LUA_FOOTER_FILE = '';
if (fs.existsSync('./scripts/footer.txt'))
  LUA_FOOTER_FILE = fs.readFileSync('./scripts/footer.txt').toString();
let REIMPORT_TEMPLATE = '';
if (fs.existsSync('./scripts/reimport_template.lua'))
  REIMPORT_TEMPLATE = fs.readFileSync('./scripts/reimport_template.lua').toString();

type ModInfo = {
  name: string | null;
  poster: string | null;
  description: string | null;
  id: string | null;
  require: string[] | null;
};

const getModInfo = (): ModInfo => {
  const modInfo: ModInfo = { id: null, name: null, poster: null, description: null, require: [] };
  const modInfoFile = fs.readFileSync('./mod.info').toString();
  const lines: string[] = modInfoFile.split('\r\n');
  for (const line of lines) {
    const lower = line.toLowerCase();
    if (lower.indexOf('id=') !== -1) {
      modInfo.id = line.split('=')[1].trim();
    } else if (lower.indexOf('name=') !== -1) {
      modInfo.name = line.split('=')[1].trim();
    } else if (lower.indexOf('description=') !== -1) {
      modInfo.description = line.split('=')[1].trim();
    } else if (lower.indexOf('poster=') !== -1) {
      modInfo.poster = line.split('=')[1].trim();
    } else if (lower.indexOf('require=') !== -1) {
      modInfo.require = line
        .split('=')[1]
        .trim()
        .split(',')
        .map((entry) => {
          return entry.trim();
        });
    }
  }
  if (modInfo.id == null) throw new Error('mod.info has no id.');
  if (modInfo.name == null) throw new Error('mod.info has no name.');
  if (modInfo.poster == null) throw new Error('mod.info has no poster.');
  if (modInfo.description == null) throw new Error('mod.info has no description.');
  return modInfo;
};

const main = () => {
  if (!fs.existsSync('./media/lua')) fs.mkdirSync('./media/lua', { recursive: true });
  if (!fs.existsSync('./media/lua/client')) fs.mkdirSync('./media/lua/client', { recursive: true });
  if (!fs.existsSync('./media/lua/server')) fs.mkdirSync('./media/lua/server', { recursive: true });
  if (!fs.existsSync('./media/lua/shared')) fs.mkdirSync('./media/lua/shared', { recursive: true });
  if (!fs.existsSync('./dist')) fs.mkdirSync('./dist', { recursive: true });

  let args = process.argv.reverse();
  args.pop();
  args.pop();
  args = args.reverse();
  if (args.length !== 0) {
    const argLower = args[0].toLowerCase();
    if (argLower === '-w' || argLower === '--watch') {
      PREFIX = '[WATCHER]';
      chokidar.watch('./src', { ignoreInitial: true }).on('all', (event, path) => {
        while (path.indexOf('\\') !== -1) {
          path = path.replace('\\', '/');
        }
        const pathLower = path.toLowerCase();
        if (pathLower === 'src/header.lua' || pathLower === 'src/footer.lua') {
          return;
        }
        if (event === 'add' || event === 'change') {
          if (!fs.lstatSync(path).isFile()) return;
          if (pathLower.endsWith('.lua')) {
            copyFile(path, 'media/lua' + path.substring(3));
            return;
          }
          if (pathLower.endsWith('.d.ts') || !pathLower.endsWith('.ts')) {
            return;
          }
          cursor.grey();
          console.log(`${PREFIX} - File changed: ${path}`);
          cursor.reset();
          compileProject();
        } else if (event === 'unlink') {
          let dst = 'media/lua' + path.substring(3);
          if (dst.toLowerCase().endsWith('.ts')) {
            dst = dst.substring(0, dst.length - 2) + 'lua';
          }
          if (fs.existsSync(dst)) {
            cursor.grey();
            cursor.reset();
            fs.rmSync(dst);
            console.log(`${PREFIX} - Deleted file: ${dst}`);
          }
        } else if (event === 'unlinkDir') {
          let dst = 'media/lua' + path.substring(3);
          if (fs.existsSync(dst)) {
            cursor.grey();
            cursor.reset();
            fs.rmdirSync(dst);
            console.log(`${PREFIX} - Deleted directory: ${dst}`);
          }
        } else if (event === 'addDir') {
          const dst = 'media/lua' + path.substring(3);
          if (!fs.existsSync(dst)) {
            cursor.grey();
            console.log(`${PREFIX} - Created file: ${dst}`);
            cursor.reset();
            fs.mkdirSync(dst, { recursive: true });
          }
        }
      });
    } else if (argLower === '-d' || argLower === '--declarations') {
      compileProjectDeclaration();
      return;
    }
  }
  compileProject();
};

const getFiles = (srcDir: string, extension: string): { [path: string]: string } => {
  const toReturn = {};
  const files = fs.readdirSync(srcDir);
  const ext = `.${extension.toLowerCase()}`;
  for (const file of files) {
    const path = `${srcDir}/${file}`;
    const lstat = fs.lstatSync(path);
    if (lstat.isDirectory()) {
      const dirFiles = getFiles(path, extension);
      for (const path of Object.keys(dirFiles)) {
        toReturn[path] = dirFiles[path];
      }
    } else {
      if (!file.toLowerCase().endsWith(ext)) continue;
      toReturn[path] = fs.readFileSync(path).toString();
    }
  }

  return toReturn;
};

const copyNonCompileFilesInDir = (srcDir: string, distDir: string) => {
  const files = fs.readdirSync(srcDir);
  for (const file of files) {
    if (file.toLowerCase().endsWith('.ts')) continue;
    const path = `${srcDir}/${file}`;
    const lstat = fs.lstatSync(path);
    if (lstat.isDirectory()) {
      copyNonCompileFilesInDir(path, path.replace(srcDir, distDir));
    } else {
      copyFile(path, path.replace(srcDir, distDir));
    }
  }
};

const copyFile = (source: string, destination: string) => {
  cursor.grey();
  console.log(`${PREFIX} - Copying "${source}" to "${destination}"..`);
  cursor.reset();
  checkDir(destination);
  if (
    destination.toLowerCase().endsWith('.lua') &&
    !destination.toLowerCase().endsWith('shared/zomboid.lua') &&
    !destination.toLowerCase().endsWith('shared/events.lua')
  ) {
    let lua = fs.readFileSync(source).toString();

    if (LUA_HEADER_FILE.length !== 0) {
      let lines: string[] = [];
      let header = LUA_HEADER_FILE.split('\r\n');
      for (let index = 0; index < header.length; index++) {
        if (index === header.length - 1 && header[index].length === 0) continue;
        lines.push(`--- ${header[index]}`);
      }
      lua = lines.join('\r\n') + `\r\n\r\n${lua}`;
    }

    if (LUA_FOOTER_FILE.length !== 0) {
      let lines: string[] = [];
      let footer = LUA_FOOTER_FILE.split('\r\n');
      for (let index = 0; index < footer.length; index++) {
        if (index === footer.length - 1 && footer[index].length === 0) continue;
        lines.push(`--- ${footer[index]}`);
      }
      lua += '\r\n' + lines.join('\r\n');
    }

    fs.writeFileSync(destination, lua);
  } else {
    fs.copyFileSync(source, destination);
  }
};

const compileProject = () => {
  const modInfo = getModInfo();

  // Reimport these files for convenience of debugging while keeping the watcher alive.
  if (fs.existsSync('./scripts/header.txt')) {
    LUA_HEADER_FILE = fs.readFileSync('./scripts/header.txt').toString();
  } else {
    LUA_HEADER_FILE = '';
  }
  if (fs.existsSync('./scripts/footer.txt')) {
    LUA_FOOTER_FILE = fs.readFileSync('./scripts/footer.txt').toString();
  } else {
    LUA_FOOTER_FILE = '';
  }
  if (fs.existsSync('./scripts/reimport_template.lua')) {
    REIMPORT_TEMPLATE = fs.readFileSync('./scripts/reimport_template.lua').toString();
  } else {
    REIMPORT_TEMPLATE = '';
  }

  cursor.brightGreen();
  process.stdout.write(`${PREFIX} - Compiling project..\n`);
  cursor.reset();
  const timeThen = new Date().getTime();
  copyNonCompileFilesInDir('./src/client', './media/lua/client');
  copyNonCompileFilesInDir('./src/server', './media/lua/server');
  copyNonCompileFilesInDir('./src/shared', './media/lua/shared');

  // TODO: Make this process automatic, not hard-coded.
  copyFile('./typings/PipeWrench/41.71/PipeWrench.lua', './media/lua/shared/PipeWrench.lua');
  copyFile(
    './typings/PipeWrench-Events/41.71/PipeWrench-Events.lua',
    './media/lua/shared/PipeWrench-Events.lua'
  );
  copyFile(
    './typings/PipeWrench-Utils/41.71/PipeWrench-Utils.lua',
    './media/lua/shared/PipeWrench-Utils.lua'
  );
  copyFile('./scripts/lualib_bundle.lua', './media/lua/shared/lualib_bundle.lua');

  // Create these temporary files so that the require paths are a certain pattern.
  if (!fs.existsSync('./src/client/_.ts')) fs.writeFileSync('./src/client/_.ts', '');
  if (!fs.existsSync('./src/server/_.ts')) fs.writeFileSync('./src/server/_.ts', '');
  if (!fs.existsSync('./src/shared/_.ts')) fs.writeFileSync('./src/shared/_.ts', '');

  transpileProject(
    'tsconfig.json',
    { emitDeclarationOnly: false },
    (
      fileName: string,
      data: string,
      _writeByteOrderMark: boolean,
      _onError?: (message: string) => void
    ) => {
      // Ignore empty files.
      if (data.length === 0) return;

      while (fileName.indexOf('\\') !== -1) fileName = fileName.replace('\\', '/');
      if (fileName.endsWith('.d.ts')) {
        // Let's figure out what to do for declarations later.
        return;
      }
      const splitter = 'media/lua/shared/';
      const indexOf = fileName.indexOf('media/lua/shared/');
      if (indexOf !== -1) {
        let subFileName;
        if (fileName.endsWith('lualib_bundle.lua')) {
          subFileName = 'media/lua/shared/lualib_bundle.lua';
        } else {
          subFileName = 'media/lua/' + fileName.substring(indexOf + splitter.length);
        }
        let lua;
        if (
          subFileName.endsWith('lualib_bundle.lua') ||
          subFileName.endsWith('PipeWrench.lua') ||
          subFileName.endsWith('PipeWrench-Events.lua')
        ) {
          lua = data;
        } else {
          let scope: Scope = 'none';
          if (subFileName.startsWith('media/lua/client')) scope = 'client';
          else if (subFileName.startsWith('media/lua/server')) scope = 'server';
          else if (subFileName.startsWith('media/lua/shared')) scope = 'shared';

          lua = fixRequire(scope, data);
          lua = applyReimportScript(lua);

          const packageJSON = JSON.parse(fs.readFileSync('./package.json').toString()) as any;

          if (LUA_HEADER_FILE.length !== 0) {
            let lines: string[] = [];
            let header = LUA_HEADER_FILE.split('\r\n');
            for (let index = 0; index < header.length; index++) {
              if (index === header.length - 1 && header[index].length === 0) continue;

              let line = header[index];
              line = replaceAll(line, '{LICENSE_YEAR}', new Date().getFullYear().toString());
              line = replaceAll(line, '{LICENSE_OWNER}', packageJSON.author);
              lines.push(line.length ? `--- ${line}` : '---');
            }
            lua = lines.join('\r\n') + `\r\n\r\n${lua}`;
          }

          if (LUA_FOOTER_FILE.length !== 0) {
            let lines: string[] = [];
            let footer = LUA_FOOTER_FILE.split('\r\n');
            for (let index = 0; index < footer.length; index++) {
              if (index === footer.length - 1 && footer[index].length === 0) continue;
              let line = footer[index];
              line = replaceAll(line, '{LICENSE_YEAR}', new Date().getFullYear().toString());
              line = replaceAll(line, '{LICENSE_OWNER}', packageJSON.author);
              lines.push(line.length ? `--- ${line}` : '---');
            }
            lua += '\r\n' + lines.join('\r\n');
          }
        }
        checkDir(subFileName);
        fs.writeFileSync(subFileName, lua);
      }
    }
  );

  // Delete the temporary file(s).
  if (fs.existsSync('./src/client/_.ts')) fs.unlinkSync('./src/client/_.ts');
  if (fs.existsSync('./src/server/_.ts')) fs.unlinkSync('./src/server/_.ts');
  if (fs.existsSync('./src/shared/_.ts')) fs.unlinkSync('./src/shared/_.ts');

  const timeNow = new Date().getTime();
  const timeDelta = timeNow - timeThen;
  const timeSeconds = timeDelta / 1000;

  cursor.brightGreen();
  process.stdout.write(`${PREFIX} - Compilation complete. Took ${timeSeconds} second(s).\n`);
  cursor.reset();
};

/**
 * (NOTE: This is a BETA feature!)
 *
 * Compiles all .ts files in the project to .d.ts files, grouping them together into one exported
 * `.d.ts` file in `./dist/`.
 */
const compileProjectDeclaration = () => {
  const modInfo = getModInfo();
  const fileName = `./dist/${modInfo.id}.d.ts`;

  cursor.brightGreen();
  console.log(`${PREFIX} - Compiling project declarations.. (file: ${fileName})`);
  cursor.reset();

  child_process.execSync(`npx tsc --declaration --outFile ${fileName}`);

  const clientDFiles = getFiles('./src/client', 'd.ts');
  const serverDFiles = getFiles('./src/server', 'd.ts');
  const sharedDFiles = getFiles('./src/shared', 'd.ts');

  let lines = fs.readFileSync(fileName).toString().split('\r\n');

  for (let index = 0; index < lines.length; index++) {
    let line = lines[index];
    // Cut out useless declarations that are empty.
    if (line.indexOf('declare module ') !== -1 && line.indexOf('{ }') !== -1) {
      lines.splice(index--, 1);
      continue;
    } else if (line.length === 0) {
      lines.splice(index--, 1);
    }
  }

  if (
    lines.length === 0 &&
    Object.keys(clientDFiles).length === 0 &&
    Object.keys(serverDFiles).length === 0 &&
    Object.keys(sharedDFiles).length === 0
  ) {
    cursor.grey();
    console.log(`${PREFIX} - No declarations to export.`);
    cursor.reset();
    child_process.execSync(`del-cli ${fileName}`);
    return;
  }

  lines.push('');

  cursor.brightGreen();
  console.log(`${PREFIX} - Refactoring project declarations..`);
  cursor.reset();

  // Header //////////////
  lines = lines.reverse();
  if (LUA_HEADER_FILE.length !== 0) {
    lines.push('');
    let header = LUA_HEADER_FILE.split('\r\n');
    header = header.reverse();
    for (let index = 0; index < header.length; index++) {
      if (index === header.length - 1 && header[index].length === 0) continue;
      lines.push(`// ${header[index]}`);
    }
  }
  lines.push('');
  lines.push('/** @noResolution @noSelfInFile */');
  lines = lines.reverse();
  // Contents //////////////
  for (const filePath of Object.keys(clientDFiles)) {
    lines.push(`/* File: ${filePath} */`);
    const fileData = clientDFiles[filePath].split('\r\n');
    for (const line of fileData) lines.push(line);
  }
  for (const filePath of Object.keys(serverDFiles)) {
    lines.push(`/* File: ${filePath} */`);
    const fileData = clientDFiles[filePath].split('\r\n');
    for (const line of fileData) lines.push(line);
  }
  for (const filePath of Object.keys(sharedDFiles)) {
    lines.push(`/* File: ${filePath} */`);
    const fileData = clientDFiles[filePath].split('\r\n');
    for (const line of fileData) lines.push(line);
  }
  for (let index = 0; index < lines.length; index++) {
    let line = lines[index];
    // Module declarations in d.ts file.
    if (line.indexOf('declare module "client/') !== -1) {
      line = line.replace('declare module "client/', 'declare module "');
    } else if (line.indexOf('declare module "server/') !== -1) {
      line = line.replace('declare module "server/', 'declare module "');
    } else if (line.indexOf('declare module "shared/') !== -1) {
      line = line.replace('declare module "shared/', 'declare module "');
    }
    // Imports in d.ts file.
    if (line.indexOf('from "client/') !== -1) line = line.replace('from "client/', 'from "');
    else if (line.indexOf('from "server/') !== -1) line = line.replace('from "server/', 'from "');
    else if (line.indexOf('from "shared/') !== -1) line = line.replace('from "shared/', 'from "');
    // Set refactored line.
    lines[index] = line;
  }

  // Footer //////////////
  if (LUA_FOOTER_FILE.length !== 0) {
    let footer = LUA_FOOTER_FILE.split('\r\n');
    for (let index = 0; index < footer.length; index++) {
      if (index === footer.length - 1 && footer[index].length === 0) continue;
      lines.push(`// ${footer[index]}`);
    }
  }

  fs.writeFileSync(fileName, lines.join('\r\n') + '\r\n');
};

const checkDir = (file: string) => {
  const split = file.split('/');
  let dir = split[0];
  for (let i = 1; i < split.length - 1; i++) {
    dir += `/${split[i]}`;
  }
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
};

/**
 * A temporary workaround for no `replaceAll` function by default.
 *
 * @param string The string to transform.
 * @param target The target phrase to replace.
 * @param to The phrase to replace the target.
 * @returns The transformed string.
 */
const replaceAll = (string: string, target: string, to: string, position: number = 0): string => {
  let index: number;
  let lastIndex: number = position;
  while ((index = string.indexOf(target, lastIndex)) !== -1) {
    string = string.replace(target, to);
    lastIndex = index + to.length;
    if (index > string.length) break;
  }
  return string;
};

/**
 * Transforms `require(..)` statements compiled by TSTL, replacing `.` with `/`. import paths
 * outside of the folder containers `client`, `server`, and `shared` are modified to resolve
 * properly in the PZ-Kahlua environment.
 *
 * (NOTE: Kahlua2 is an imperfect emulator for Lua 5.1)
 *
 * @param scope The original scope where the require statement came from.
 * @param lua The require statement to fix.
 * @returns The fixed require statement.
 */
const fixRequire = (scope: Scope, lua: string): string => {
  if (lua.length === 0) return '';
  const fix = (fromImport: string): string => {
    let toImport = replaceAll(fromImport, '.', '/');
    // Remove cross-references for client/server/shared.
    if (toImport.startsWith('shared/')) {
      toImport = toImport.substring('shared/'.length);
    } else if (toImport.startsWith('client/')) {
      if (scope === 'server') {
        cursor.yellow();
        console.warn(
          `${PREFIX} - Cannot reference code from src/client from src/server. ` +
            '(Code will fail when ran)'
        );
        cursor.reset();
      }
      toImport = toImport.substring('client/'.length);
    } else if (toImport.startsWith('server/')) {
      if (scope === 'client') {
        cursor.yellow();
        console.warn(
          `${PREFIX} - Cannot reference code from src/server from src/client. ` +
            '(Code will fail when ran)'
        );
        cursor.reset();
      }
      toImport = toImport.substring('server/'.length);
    }
    return toImport;
  };
  let index = -1;
  do {
    let fromImport = '';
    index = lua.indexOf('require("');
    if (index !== -1) {
      index += 9;
      // Grab the require string.
      while (index < lua.length) {
        const char = lua.charAt(index++);
        if (char === '"') break;
        fromImport += char;
      }
      const toImport = fix(fromImport);
      // Kahlua only works with '/', nor '.' in 'require(..)'.
      const from = 'require("' + fromImport + '")';
      let to = "require('" + replaceAll(toImport, '.', '/') + "')";
      lua = lua.replace(from, to);
    }
  } while (index !== -1);

  return lua;
};

/**
 * This applies a codeblock for reimporting Lua objects after PipeWrench loads. The reason for this
 * is due to not having initialized Lua objects when PipeWrench initially loads in Kahlua2. To work
 * around this problem, the assignments are detected when scanned through the compiled TSTL code and
 * then feed into the 'OnPipeWrenchBoot' event wrapper in './scripts/reimport_template.lua`.
 *
 * @param lua The code to transform & append.
 * @returns The transformed code.
 */
const applyReimportScript = (lua: string): string => {
  const assignments: string[] = [];
  const lines = lua.split('\n');

  // Look for any PipeWrench assignments.
  for (const line of lines) {
    if (line.indexOf('local ') === 0 && line.indexOf('____PipeWrench.') !== -1) {
      assignments.push(line.replace('local ', ''));
    }
  }

  // Only generate a reimport codeblock if there's anything to import.
  if (!assignments.length) return lua;

  // Take out the returns statement so we can insert before it.
  lines.pop();
  const returnLine: string = lines.pop() as string;
  lines.push('');

  // Build the reimport event.
  let compiledImports = '';
  for (const assignment of assignments) compiledImports += `${assignment}\n`;
  const reimports = REIMPORT_TEMPLATE.replace(
    '-- {IMPORTS}',
    compiledImports.substring(0, compiledImports.length - 1)
  );

  return `${lines.join('\n')}\n${reimports}\n\n${returnLine}\n`;
};

main();
