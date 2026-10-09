// =============================================================================
// 文件名称：read-only-command.mjs
// 所属模块：infra
// 作用说明：对已知只读工具和 Shell 语法/参数作确定性分类，不执行命令。
// 运行原理：逐字符拆分引号与管道 → 每一段核对命令/参数 → 全部只读才放行。
// =============================================================================

/** 已知宿主只读工具；不按名称包含 read/search 猜测第三方工具的副作用。 */
export function isReadOnlyTool(name) {
  return /^(?:(?:functions\.)?(?:Read|Glob|Grep|read_file|read_text_file|read_multiple_files|list_directory|search_files))$/i.test(String(name));
}

/** 只接受可验证的只读命令组合；任一段未知、写入或含执行语法就返回 false。 */
export function isReadOnlyShellCommand(command) {
  const parts = tokenizeReadCommands(command);
  return Boolean(parts?.length && parts.every(isReadCommand));
}

/** 仅解析文字参数及只读组合连接符，不尝试解释完整 Bash/PowerShell 程序。 */
function tokenizeReadCommands(command) {
  if (typeof command !== 'string' || !command.trim()) return null;
  const text = command.trim(), parts = [], args = [];
  let token = '', started = false, quote = '', closed = false, escaped = false;
  const flush = () => {
    // shell 会去掉未加引号的反斜杠：\-\-pre 实际是 --pre，不能当普通词放行
    if (escaped && token.replaceAll('\\', '').startsWith('-')) return false;
    if (started) args.push(token);
    token = ''; started = false; closed = false; escaped = false;
    return true;
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    // 只丢弃输出的重定向不写文件：2>&1、>/dev/null、2>/dev/null
    const discard = !quote && !started && /^(?:2>&1|[12]?>\s*\/dev\/null)(?=\s|$|[;&|])/.exec(text.slice(i));
    if (discard) { i += discard[0].length - 1; continue; }
    if (quote) {
      if (ch === quote) { quote = ''; closed = true; continue; }
      if (quote === '"' && /[$`%!^]/.test(ch)) return null;
      if (ch === '\\' && text[i + 1] === quote) return null;
      token += ch; continue;
    }
    if (ch === '"' || ch === "'") {
      if (started) return null;
      started = true; quote = ch; continue;
    }
    if (/[$`%!^<>()[\]{}\0]/.test(ch)) return null;
    if (ch === '\\' && /[\s;&|'"<>]/.test(text[i + 1] || '')) return null;
    if (ch === '\\') escaped = true;
    if (ch === ';' || ch === '|' || ch === '&' || ch === '\n') {
      if (!flush()) return null;
      if (ch === '&' && text[i + 1] !== '&') return null;
      if ((ch === '&' || ch === '|') && text[i + 1] === ch) i++;
      if (args.length) { parts.push(args.splice(0)); }
      else if (ch !== '\n') return null;
      continue;
    }
    if (/\s/.test(ch)) { if (!flush()) return null; continue; }
    if (closed) return null;
    token += ch; started = true;
  }
  if (quote) return null;
  if (!flush()) return null;
  if (!args.length) return null;
  parts.push(args);
  return parts;
}

/** 每个支持的程序均明确列出选项；不能把所有非危险选项默认为安全。 */
function isReadCommand([raw, ...args]) {
  const name = raw.toLowerCase().replace(/\.exe$/, '');
  switch (name) {
    case 'rg': return checkOptions(args,
      ['--files','--hidden','--no-ignore','--no-ignore-vcs','--no-config','--line-number','--column','--heading','--no-heading','--fixed-strings','--ignore-case','--smart-case','--count','--count-matches','--files-with-matches','--files-without-match','--only-matching','--word-regexp','--multiline','--pcre2','--json','--stats','--trim','--no-messages','--null','--follow'],
      ['--glob','--iglob','--type','--type-not','--max-count','--max-depth','--max-columns','--max-filesize','--context','--before-context','--after-context','--regexp','--file','--encoding','--color','--sort','--sortr'], 'nivwxlLFsoUcuzPH', 'gtemABC');
    case 'cat': return checkOptions(args,['--number','--number-nonblank','--show-ends','--show-tabs','--squeeze-blank'],[], 'nbAETsv', '');
    case 'head': case 'tail': return checkOptions(args,['--quiet','--verbose'],['--lines','--bytes'],'qv','nc',true);
    case 'ls': return checkOptions(args,['--all','--almost-all','--recursive','--directory','--human-readable','--classify','--full-time'],['--color','--sort','--time-style'],'alhRdFtrS1','');
    case 'wc': return checkOptions(args,['--lines','--words','--bytes','--chars','--max-line-length'],[],'lwcmL','');
    case 'sed': return isReadSed(args);
    case 'find': return isReadFind(args);
    case 'pwd': return args.length === 0 || args.every(x=>['-L','-P'].includes(x));
    case 'grep': return checkOptions(args,['--line-number','--recursive','--ignore-case','--fixed-strings','--extended-regexp','--count','--files-with-matches','--only-matching','--word-regexp','--no-messages'],['--include','--exclude','--exclude-dir','--max-count','--context','--before-context','--after-context','--regexp','--file'],'nirRlLFEsovw','emABC');
    case 'get-content': case 'gc': return checkPsOptions(args,['-raw','-force'],['-path','-literalpath','-totalcount','-head','-tail','-encoding','-delimiter']);
    case 'get-childitem': case 'gci': return checkPsOptions(args,['-force','-recurse','-file','-directory','-name','-hidden'],['-path','-literalpath','-filter','-include','-exclude','-depth']);
    case 'get-item': return checkPsOptions(args,['-force'],['-path','-literalpath']);
    case 'select-string': return checkPsOptions(args,['-simplematch','-casesensitive','-list','-allmatches','-notmatch','-quiet','-raw'],['-pattern','-path','-literalpath','-context','-encoding']);
    case 'select-object': return checkPsOptions(args,['-unique'],['-first','-last','-skip','-skiplast','-property','-expandproperty']);
    case 'out-string': return checkPsOptions(args,['-stream'],['-width']);
    case 'get-location': return args.length === 0;
    case 'git': return isReadGit(args);
    default: return false;
  }
}

/** GNU 风格选项解析，值消费和 -- 结束选项后均仅为字面量。 */
function checkOptions(args, flags, values, shortFlags, shortValues, numeric = false) {
  for(let i=0;i<args.length;i++) {
    const arg=args[i];
    if(arg==='--') return true;
    if(!arg.startsWith('-') || arg==='-') continue;
    if(numeric && /^-\d+$/.test(arg)) continue;
    if(arg.startsWith('--')) {
      const [key,...rest]=arg.split('=');
      if(flags.includes(key) && rest.length===0) continue;
      if(!values.includes(key)) return false;
      if(rest.length===0 && ++i>=args.length) return false;
      continue;
    }
    for(let j=1;j<arg.length;j++) {
      if(shortFlags.includes(arg[j])) continue;
      if(!shortValues.includes(arg[j])) return false;
      if(j===arg.length-1 && ++i>=args.length) return false;
      break;
    }
  }
  return true;
}

/** PowerShell 仅允许完整已知参数名，不接受缩写、CommonParameters 输出变量或脚本块。 */
function checkPsOptions(args, flags, values) {
  for(let i=0;i<args.length;i++) {
    const arg=args[i].toLowerCase();
    if(!arg.startsWith('-')) continue;
    if(flags.includes(arg)) continue;
    if(!values.includes(arg) || ++i>=args.length) return false;
  }
  return true;
}

/**
 * Git 查询禁止 -c、切换仓库、输出文件和外部 diff。
 * 不允许 -C/--git-dir/--work-tree：其他仓库的配置（core.fsmonitor、diff.external）会在 status/diff 时执行程序。
 * 当前仓库与用户级配置视为可信：改写它们本身需要写权限，届时已不受只读放行约束。
 * Agent 的 shell 不是 TTY，git 不会启动分页器，因此不要求 --no-pager。
 */
function isReadGit(args) {
  if (args[0] === '--no-pager') args.shift();
  const verb=args.shift();
  const diffFlags=['--stat','--shortstat','--numstat','--name-only','--name-status','--check','--no-ext-diff','--no-textconv','--no-color','--patch','--no-patch','--oneline'];
  const diffValues=['--format','--pretty','--unified','--color'];
  if(verb==='status') return checkOptions(args,['--short','--branch','--porcelain','--show-stash','--ahead-behind','--no-ahead-behind'],['--untracked-files','--ignored'],'sb','');
  if(verb==='log') return checkOptions(args,[...diffFlags,'--all','--graph','--decorate','--no-decorate','--reverse','--first-parent','--no-merges','--merges','--follow'],[...diffValues,'--max-count','--since','--until','--author','--grep'],'p','nU',true);
  if(verb==='show') return checkOptions(args,diffFlags,diffValues,'p','U');
  if(verb==='diff') return checkOptions(args,[...diffFlags,'--cached','--staged'],diffValues,'p','U');
  if(verb==='rev-parse') return args.length===1 && /^(?:HEAD|--show-toplevel|--git-dir|--is-inside-work-tree)$/.test(args[0]);
  // 带位置参数的 git branch 会新建分支，只接受纯查询选项
  if(verb==='branch') return args.every(x=>['--show-current','-a','--all','-r','--remotes','-v','-vv','--verbose','--no-color'].includes(x));
  if(verb==='worktree') return args[0]==='list' && args.slice(1).every(x=>['--porcelain','-z'].includes(x));
  if(verb==='ls-files') return checkOptions(args,['--modified','--deleted','--others','--exclude-standard','--cached','--stage'],[],'mdozcs','');
  return false;
}

/** sed 只接受 `-n <行号范围>p`：脚本中的 w/e/r 等命令可写文件或执行程序。 */
function isReadSed(args) {
  return args[0]==='-n' && /^(?:\d+|\$)(?:,(?:\d+|\$))?p$/.test(args[1]||'') && args.slice(2).every(x=>!x.startsWith('-'));
}

/** find 只接受筛选条件；-exec/-delete/-fprint 等动作一律拒绝。 */
function isReadFind(args) {
  const flags=['-print','-print0','-a','-and','-o','-or','-not','-empty','-follow'];
  const values=['-name','-iname','-path','-ipath','-type','-maxdepth','-mindepth','-newer','-size','-mtime','-mmin'];
  for(let i=0;i<args.length;i++) {
    if(!args[i].startsWith('-')) continue;
    if(flags.includes(args[i])) continue;
    if(!values.includes(args[i]) || ++i>=args.length) return false;
  }
  return true;
}
