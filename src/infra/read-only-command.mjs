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
  let token = '', started = false, quote = '', closed = false;
  const flush = () => { if (started) args.push(token); token = ''; started = false; closed = false; };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
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
    if (ch === ';' || ch === '|' || ch === '&' || ch === '\n') {
      flush();
      if (ch === '&' && text[i + 1] !== '&') return null;
      if ((ch === '&' || ch === '|') && text[i + 1] === ch) i++;
      if (args.length) { parts.push(args.splice(0)); }
      else if (ch !== '\n') return null;
      continue;
    }
    if (/\s/.test(ch)) { flush(); continue; }
    if (closed) return null;
    token += ch; started = true;
  }
  if (quote) return null;
  flush();
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

/** Git 查询禁止 -c、输出文件、外部 diff/textconv；内容查询要求显式禁用 helper。 */
function isReadGit(args) {
  let noPager=false;
  while(args.length && ['--no-pager','-C'].includes(args[0])) {
    const option=args.shift();
    if(option==='--no-pager') noPager=true;
    else if(!args.shift()) return false;
  }
  const verb=args.shift();
  if(verb==='status') return checkOptions(args,['--short','--branch','--porcelain','--show-stash','--ahead-behind','--no-ahead-behind'],['--untracked-files','--ignored'],'sb','');
  if(verb==='log') return noPager && checkOptions(args,['--oneline','--all','--graph','--decorate','--no-decorate','--stat','--name-only','--name-status','--no-color','--no-ext-diff','--no-textconv'],['--max-count','--format','--pretty','--since','--until','--author'],'','n',true);
  if(verb==='show' || verb==='diff') return noPager && args.includes('--no-ext-diff') && args.includes('--no-textconv') && checkOptions(args,['--no-ext-diff','--no-textconv','--no-color','--stat','--name-only','--name-status','--check','--cached','--staged'],['--format','--pretty'],'','');
  if(verb==='rev-parse') return args.length===1 && /^(?:HEAD|--show-toplevel|--git-dir|--is-inside-work-tree)$/.test(args[0]);
  if(verb==='branch') return args.length===1 && args[0]==='--show-current';
  if(verb==='worktree') return args[0]==='list' && args.slice(1).every(x=>['--porcelain','-z'].includes(x));
  if(verb==='ls-files') return checkOptions(args,['--modified','--deleted','--others','--exclude-standard','--cached','--stage'],'','mdozcs','');
  return false;
}
