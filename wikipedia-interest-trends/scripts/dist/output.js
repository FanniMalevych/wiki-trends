// Every command prints exactly one JSON envelope on stdout so an agent can
// parse results without scraping text.
export function success(data, warnings = []) {
    return { ok: true, data, warnings, errors: [] };
}
export function failure(errors, warnings = []) {
    return { ok: false, data: null, warnings, errors };
}
export function emit(envelope) {
    process.stdout.write(JSON.stringify(envelope, null, 2) + "\n");
}
