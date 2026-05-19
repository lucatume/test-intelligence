import ts from 'typescript';
import { CompilerOptionsResolver } from '../extract/ts/compiler.js';

const EXCLUDED_RE = /(\/node_modules\/|\/vendor\/|\/dist\/|\/build\/|\.min\.|\/\.git\/)/;

export interface ResolutionProgram {
  readonly program: ts.Program;
  readonly checker: ts.TypeChecker;
}

// Build one ts.Program over the import-closure of `seedAbsFiles`. The closure
// walk is bounded: files matching EXCLUDED_RE are refused by the custom host so
// TypeScript never descends into node_modules, vendor, dist, build, .min.*, or
// .git. CompilerOptions come from CompilerOptionsResolver so tsconfig path
// aliases resolve. Returns the program and its TypeChecker.
export function buildResolutionProgram(
  seedAbsFiles: readonly string[],
  projectRoot: string,
): ResolutionProgram {
  const resolver = new CompilerOptionsResolver(projectRoot);
  const baseOptions = resolver.forFile(seedAbsFiles[0] ?? projectRoot);
  const options: ts.CompilerOptions = {
    ...baseOptions,
    allowJs: true,
    noEmit: true,
    skipLibCheck: true,
  };

  const defaultHost = ts.createCompilerHost(options);

  const host: ts.CompilerHost = {
    ...defaultHost,
    fileExists(fileName: string): boolean {
      if (EXCLUDED_RE.test(fileName)) return false;
      return defaultHost.fileExists(fileName);
    },
    readFile(fileName: string): string | undefined {
      if (EXCLUDED_RE.test(fileName)) return undefined;
      return defaultHost.readFile(fileName);
    },
    getSourceFile(
      fileName: string,
      languageVersionOrOptions: ts.ScriptTarget | ts.CreateSourceFileOptions,
      onError?: (message: string) => void,
      shouldCreateNewSourceFile?: boolean,
    ): ts.SourceFile | undefined {
      if (EXCLUDED_RE.test(fileName)) return undefined;
      return defaultHost.getSourceFile(
        fileName,
        languageVersionOrOptions,
        onError,
        shouldCreateNewSourceFile,
      );
    },
  };

  const program = ts.createProgram(seedAbsFiles as string[], options, host);
  return { program, checker: program.getTypeChecker() };
}
