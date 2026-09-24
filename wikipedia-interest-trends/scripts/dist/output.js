// Every command prints exactly one JSON envelope on stdout so an agent can
// parse results without scraping text. It is compact (one line) to save the
// agent's context; pipe through `jq` to read it yourself.
export function success(data, warnings = []) {
    return { ok: true, data, warnings, errors: [] };
}
export function failure(errors, warnings = []) {
    return { ok: false, data: null, warnings, errors };
}
export function emit(envelope) {
    process.stdout.write(JSON.stringify(envelope) + "\n");
}
