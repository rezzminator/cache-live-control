export const PLUGIN_LOG_CAP_BYTES = 20_971_520;
export const ROW_MAX_BYTES = 4096;
export type PluginLogLevel = 'error' | 'warning' | 'info';
export type PluginLogFields = {
  plugin: string;
  level: PluginLogLevel;
  event: string;
  msg: string;
  where: string;
  session?: string;
  detail?: Record<string, unknown>;
};
export type PluginLogRow = { level: PluginLogLevel; row: string };
export type PluginLogRun = (argv: readonly string[]) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
export type FlushResult = { written: number; dropped: number };

/** UTF-8 bytes without a host import: the hook loader accepts only local modules. */
function bytes(text: string): number {
  let count = 0;
  for (const char of text) {
    const code = char.codePointAt(0)!;
    count += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
  }
  return count;
}

export function levelRow(fields: PluginLogFields, nowMs: number): string {
  const row: PluginLogFields & { ts: string } = {
    ts: new Date(nowMs).toISOString(),
    plugin: fields.plugin,
    level: fields.level,
    event: fields.event,
    msg: fields.msg,
    where: fields.where,
    ...(fields.session === undefined ? {} : { session: fields.session }),
    ...(fields.detail === undefined ? {} : { detail: fields.detail }),
  };
  const encode = () => JSON.stringify(row) + '\n';
  let text = encode();
  const originalBytes = bytes(text);
  if (originalBytes <= ROW_MAX_BYTES) return text;
  row.detail = { truncated: true, bytes: originalBytes };
  // A fixed plugin's identifiers are tiny. Bound them too if a malformed caller
  // supplies huge ones, keeping JSON and the row limit intact.
  for (const key of ['msg', 'where', 'event', 'session', 'plugin'] as const) {
    text = encode();
    if (bytes(text) <= ROW_MAX_BYTES) return text;
    const value = row[key];
    if (value === undefined) continue;
    const chars = Array.from(value);
    let low = Math.min(1, chars.length);
    let high = chars.length;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      row[key] = chars.slice(0, mid).join('');
      if (bytes(encode()) <= ROW_MAX_BYTES) low = mid;
      else high = mid - 1;
    }
    row[key] = chars.slice(0, low).join('');
  }
  return encode();
}

export function pluginLogDir(root: string | undefined, home: string | undefined, plugin: string): string | undefined {
  if (root) return `${root.replace(/\/+$/, '')}/${plugin}`;
  if (home) return `${home.replace(/\/+$/, '')}/.local/state/${plugin}/logs`;
  return undefined;
}

// Positional arguments only: neither a path nor JSON is shell source. Each
// printf appends one bounded row, opening and closing the file for that write.
export const APPEND_SCRIPT = `set -eu
LC_ALL=C
export LC_ALL
umask 077
dir=$1
plugin=$2
shift 2
# BSD chmod (macOS) reads a "--" operand as a file name, so no chmod below takes it: a
# directory that starts with a dash is made a ./ path instead.
case "$dir" in -*) dir=./$dir ;; esac
if [ -L "$dir" ]; then echo "plugin log $dir: directory is a symlink" >&2; exit 1; fi
for leaf in errors.jsonl errors.jsonl.1 warnings.jsonl warnings.jsonl.1 info.jsonl info.jsonl.1; do
  if [ -L "$dir/$leaf" ]; then echo "plugin log $dir/$leaf: level endpoint is a symlink" >&2; exit 1; fi
done
case "$plugin" in ''|*[!a-z0-9-]*) echo "plugin log $dir: invalid plugin name" >&2; exit 2;; esac
mkdir -p -- "$dir"
if [ ! -w "$dir" ]; then echo "plugin log $dir: directory not writable" >&2; exit 1; fi
chmod 700 "$dir"
private_file() {
  if [ -e "$1" ]; then
    if [ ! -f "$1" ] || [ ! -w "$1" ]; then echo "plugin log $1: level file not writable" >&2; return 1; fi
    chmod 600 "$1"
  fi
}
private_backup() {
  if [ -L "$1" ]; then echo "plugin log $1: level backup is a symlink" >&2; return 1; fi
  private_file "$1"
}
cap_row() {
  printf '{"ts":"%s","plugin":"%s","level":"warning","event":"log-capped","msg":"%s","where":"src/plugin-log.ts#APPEND_SCRIPT"%s,"detail":%s}' "$ts" "$plugin" "$cap_msg" "$session_field" "$cap_detail"
}
# The input is the canonical JSON string from levelRow, not shell source.
# Retain complete JSON escape sequences and UTF-8 code points when bounding it.
clip_session() {
  remaining=$session_value
  remaining=\${remaining#?}
  remaining=\${remaining%?}
  continuation=$(printf '\\200-\\277')
  backslash=$(printf '\\134')
  while [ "\${#remaining}" -gt "$budget" ]; do
    case "$remaining" in
      *[$continuation])
        while :; do
          case "$remaining" in *[$continuation]) remaining=\${remaining%?};; *) break;; esac
        done
        remaining=\${remaining%?};;
      *)
        count=1
        case "$remaining" in
          *"$backslash"u????) count=6;;
          *"$backslash"?) count=2;;
        esac
        if [ "$count" -gt 1 ]; then
          if [ "$count" -eq 6 ]; then prefix=\${remaining%??????}; else prefix=\${remaining%??}; fi
          escapes=0
          while :; do
            case "$prefix" in *"$backslash") escapes=$((escapes + 1)); prefix=\${prefix%?};; *) break;; esac
          done
          if [ "$((escapes % 2))" -ne 0 ]; then count=1; fi
        fi
        if [ "$count" -eq 6 ]; then remaining=\${remaining%??????};
        elif [ "$count" -eq 2 ]; then remaining=\${remaining%??};
        else remaining=\${remaining%?}; fi;;
    esac
  done
  session_field=',"session":"'$remaining'"'
}
cap_warning() {
  session_field=
  if [ -n "$session_value" ]; then session_field=$session_key$session_value; fi
  cap_msg='level file moved aside at size cap'
  cap_detail=$(printf '{"file":"%s","bytes":%s}' "$1" "$2")
  warning=$(cap_row)
  original_bytes=$(printf '%s\\n' "$warning" | wc -c)
  if [ "$original_bytes" -gt 4096 ]; then
    cap_detail=$(printf '{"truncated":true,"bytes":%s}' "$((original_bytes))")
    warning=$(cap_row)
    while [ "$(printf '%s\\n' "$warning" | wc -c)" -gt 4096 ] && [ "\${#cap_msg}" -gt 1 ]; do
      cap_msg=\${cap_msg%?}
      warning=$(cap_row)
    done
    if [ "$(printf '%s\\n' "$warning" | wc -c)" -gt 4096 ]; then
      session_field=',"session":""'
      warning=$(cap_row)
      budget=$((4096 - $(printf '%s\\n' "$warning" | wc -c)))
      clip_session
      warning=$(cap_row)
    fi
  fi
  printf '%s\\n' "$warning" >> "$dir/warnings.jsonl"
}
while [ "$#" -gt 0 ]; do
  file=$1
  row=$2
  shift 2
  case "$file" in errors.jsonl|warnings.jsonl|info.jsonl) ;; *) echo "plugin log $dir: invalid level file" >&2; exit 2;; esac
  target=$dir/$file
  private_file "$target"
  private_backup "$target.1"
  if [ -f "$target" ]; then
    size=$(wc -c < "$target")
    if [ "$size" -gt ${PLUGIN_LOG_CAP_BYTES} ]; then
      mv -f -- "$target" "$target.1"
      ts=\${row#*\\"ts\\":\\"}
      ts=\${ts%%\\"*}
      # session is last in the canonical header; detail may contain fake keys.
      detail_key=',"detail":'
      session_key=',"session":'
      end='}'
      header=\${row%?}
      header=\${header%"$end"}
      header=\${header%%"$detail_key"*}
      session_value=
      session_field=
      case "$header" in *"$session_key"*) session_value=\${header#*"$session_key"}; session_field=$session_key$session_value;; esac
      private_file "$dir/warnings.jsonl"
      private_backup "$dir/warnings.jsonl.1"
      if [ -f "$dir/warnings.jsonl" ]; then
        warning_size=$(wc -c < "$dir/warnings.jsonl")
        if [ "$warning_size" -gt ${PLUGIN_LOG_CAP_BYTES} ]; then
          mv -f -- "$dir/warnings.jsonl" "$dir/warnings.jsonl.1"
          cap_warning warnings.jsonl "$warning_size"
        fi
      fi
      cap_warning "$file" "$size"
    fi
  fi
  printf '%s' "$row" >> "$target"
done
`;

export function appendArgv(dir: string, plugin: string, rows: readonly PluginLogRow[]): string[][] {
  const files = { error: 'errors.jsonl', warning: 'warnings.jsonl', info: 'info.jsonl' };
  const batches: string[][] = [];
  for (let start = 0; start < rows.length; start += 64) {
    const argv = ['/bin/sh', '-c', APPEND_SCRIPT, 'plugin-log', dir, plugin];
    for (const row of rows.slice(start, start + 64)) argv.push(files[row.level], row.row);
    batches.push(argv);
  }
  return batches;
}

/** One queue per hook registration; a bad batch never escapes into hook work. */
export class PluginLogQueue {
  private rows: PluginLogRow[] = [];
  private chain: Promise<FlushResult> = Promise.resolve({ written: 0, dropped: 0 });
  private failing = false;

  constructor(private dir: string | undefined, private plugin: string, private notice: (text: string) => void) {}

  add(row: PluginLogRow): void { this.rows.push(row); }

  private failed(error: string, dropped: number): void {
    if (this.failing) return;
    this.failing = true;
    this.notice(this.dir === undefined ? 'plugin log off: no PLUGIN_LOG_DIR and no HOME' : `plugin log ${this.dir}: ${error}; dropped ${dropped} row(s)`);
  }

  flush(run: PluginLogRun): Promise<FlushResult> {
    const work = async (): Promise<FlushResult> => {
      const result = { written: 0, dropped: 0 };
      while (this.rows.length > 0) {
        const batch = this.rows.splice(0, 64);
        if (this.dir === undefined) {
          result.dropped += batch.length;
          this.failed('no directory', batch.length);
          continue;
        }
        try {
          const output = await run(appendArgv(this.dir, this.plugin, batch)[0]!);
          if (output.exitCode !== 0) {
            result.dropped += batch.length;
            this.failed(output.stderr.split('\n')[0] || `exit ${output.exitCode}`, batch.length);
          } else {
            result.written += batch.length;
            this.failing = false;
          }
        } catch (error) {
          result.dropped += batch.length;
          this.failed(error instanceof Error ? error.message : String(error), batch.length);
        }
      }
      return result;
    };
    this.chain = this.chain.then(work);
    return this.chain;
  }
}
