// node:sqlite prints an ExperimentalWarning on stderr on some Node versions.
// Agents often read stderr together with stdout, so drop that one warning.
// Must be the first import in cli.ts so it runs before node:sqlite loads.
const emitWarning = process.emitWarning.bind(process);
process.emitWarning = ((warning, ...rest) => {
    const message = typeof warning === "string" ? warning : warning.message;
    if (/SQLite is an experimental feature/i.test(message))
        return;
    emitWarning(warning, ...rest);
});
export {};
