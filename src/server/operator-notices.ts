/**
 * Where the host tells its operator what happened: readiness and the HTTP log
 * on stdout, lost connections and failures on stderr. Each call is one line,
 * without its trailing newline.
 *
 * It is passed beside the parsed CLI options rather than inside them, because
 * those are configuration an operator chose and this is where the process
 * reports. Production omits it and gets {@link processNotices}; a test passes
 * its own so it can assert the notice an operator would have been shown
 * without the run printing it.
 */
export interface OperatorNotices {
  stdout(line: string): void;
  stderr(line: string): void;
}

/** Production's notices: one line per call on the process's own streams. */
export const processNotices: OperatorNotices = {
  stdout: (line) => process.stdout.write(`${line}\n`),
  stderr: (line) => process.stderr.write(`${line}\n`),
};
