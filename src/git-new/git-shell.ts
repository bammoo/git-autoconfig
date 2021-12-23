import * as cp from "child_process";
import { EventEmitter } from "events";
import * as fs from "fs";
import * as iconv from "iconv-lite";
import * as os from "os";
import * as path from "path";
import {
  assign,
  debug,
  denodeify,
  dispose,
  groupBy,
  IDisposable,
  mkdirp,
  toDisposable,
  uniqBy,
} from "./utils";

// tslint:disable:member-ordering

const readdir = denodeify<string[]>(fs.readdir);
const readfile = denodeify<string>(fs.readFile);

/**
 * 抽象的 git 二进制对象
 */
export interface IGit {
  path: string;
  version: string;
}

/**
 * 描述了文件状态
 *
 * |    X        |    Y    |   Meaning                          |
 * | ----------- | ------- | ---------------------------------- |
 * |             |   [MD]  |  not updated                       |
 * |    M        |  [ MD]  |  updated in index                  |
 * |    A        |  [ MD]  |  added to index                    |
 * |    D        |   [ M]  |  deleted from index                |
 * |    R        |  [ MD]  |  renamed in index                  |
 * |    C        |  [ MD]  |  copied in index                   |
 * |    [MARC]   |         |  index and work tree matches       |
 * |    [ MARC]  |     M   |  work tree changed since index     |
 * |    [ MARC]  |     D   |  deleted in work tree              |
 * | ----------- | ------- | ---------------------------------- |
 * |    D        |     D   |  unmerged, both deleted            |
 * |    A        |     U   |  unmerged, added by us             |
 * |    U        |     D   |  unmerged, deleted by them         |
 * |    U        |     A   |  unmerged, added by them           |
 * |    D        |     U   |  unmerged, deleted by us           |
 * |    A        |     A   |  unmerged, both added              |
 * |    U        |     U   |  unmerged, both modified           |
 * | ----------- | ------- | ---------------------------------- |
 * |    ?        |     ?   |  untracked                         |
 * |    !        |     !   |  ignored                           |
 * | ----------- | ------- | ---------------------------------- |
 */
export interface IFileStatus {
  x: string;
  y: string;
  path: string;
  /** 是否是重命名的 */
  rename?: string;
}

/**
 * 描述了每一条 commit 信息
 */
export interface IGitLog {
  /** commit id */
  commit: string;
  /** 父提交，如果是merge，会有两个，否则一个 */
  parents: string[];
  /** 是否由 merge 产生 */
  isMerged: boolean;
  date: Date;
  /** 提交人 */
  author: string;
  /** commit 信息 */
  message: string;
}

export interface IRemote {
  name: string;
  url: string;
}

export interface Stash {
  index: number;
  description: string;
}

export enum RefType {
  Head,
  RemoteHead,
  RemoteTag,
  Tag,
}

/** 可以得到唯一一个 git commit 的信息都可以作为 ref */
export interface IRef {
  type?: RefType;
  name?: string;
  commit?: string;
  remote?: string;
}

export interface IBranch extends IRef {
  upstream?: string;
  ahead?: number;
  behind?: number;
}

function parseVersion(raw: string): string {
  return raw.replace(/^git version /, "");
}

function findSpecificGit(execPath: string): Promise<IGit> {
  return new Promise((c, e) => {
    const buffers: Buffer[] = [];
    const child = cp.spawn(execPath, ["--version"]);
    child.stdout.on("data", (buf: Buffer) => buffers.push(buf));
    child.on("error", e);
    child.on("exit", (code) => {
      if (code) {
        e(new Error("Not found"));
      } else {
        c({
          path: fs.realpathSync(execPath),
          version: parseVersion(Buffer.concat(buffers).toString("utf8").trim()),
        });
      }
    });
  });
}

function findGitDarwin(): Promise<IGit> {
  return new Promise<IGit>((c, e) => {
    cp.exec("which git", (err, gitPathBuffer) => {
      if (err) {
        return e("git not found");
      }

      // tslint:disable-next-line:no-shadowed-variable
      const path = fs.realpathSync(gitPathBuffer.toString().trim());
      // tslint:disable-next-line:no-shadowed-variable
      function getVersion(path: string) {
        cp.exec("git --version", (error, stdout) => {
          if (error) {
            return e("git not found.");
          }

          return c({ path, version: parseVersion(stdout.trim()) });
        });
      }
      if (path !== "/usr/bin/git") {
        return getVersion(path);
      }
      cp.exec("xcode-select -p", (error: any) => {
        if (error && error.code === 2) {
          return e("git not install");
        }
        getVersion(path);
      });
    });
  });
}

function findSystemGitWin32(base: string): Promise<IGit> {
  if (!base) {
    return Promise.reject<IGit>("Not Found");
  }
  return findSpecificGit(path.join(base, "Git", "cmd", "git.exe"));
}

function findGitHubGitWin32(): Promise<IGit> {
  const github = path.join(process.env.LOCALAPPDATA, "GitHub");

  return readdir(github).then((children) => {
    const git = children.filter((child) => /^PortableGit/.test(child))[0];

    if (!git) {
      return Promise.reject<IGit>("Not found");
    }

    return findSpecificGit(path.join(github, git, "cmd", "git.exe"));
  });
}

function findGitWin32(): Promise<IGit> {
  return findSystemGitWin32(process.env["ProgramW6432"])
    .then(void 0, () => findSystemGitWin32(process.env["ProgramFiles(x86)"]))
    .then(void 0, () => findSystemGitWin32(process.env["ProgramFiles"]))
    .then(void 0, () => findSpecificGit("git"))
    .then(void 0, () => findGitHubGitWin32());
}

/** 查找系统中的 git 二进制文件 */
export function findGit(hint?: string | undefined): Promise<IGit> {
  const first = hint ? findSpecificGit(hint) : Promise.reject<IGit>(null);
  return first.then(void 0, () => {
    switch (process.platform) {
      case "darwin":
        return findGitDarwin();
      case "win32":
        return findGitWin32();
      default:
        return findSpecificGit("git");
    }
  });
}

/** 运行其他二进制的返回结果 */
export interface IExecutionResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** 收集其他二进制程序运行的结果 */
async function exec(
  child: cp.ChildProcess,
  options: any = {}
): Promise<IExecutionResult> {
  if (!child.stdout || !child.stderr) {
    throw new GitError({
      message: "Failed to get stdout or stderr from git process.",
    });
  }

  const disposables: IDisposable[] = [];

  // tslint:disable-next-line:ban-types
  const once = (ee: NodeJS.EventEmitter, name: string, fn: any) => {
    ee.once(name, fn);
    disposables.push(toDisposable(() => ee.removeListener(name, fn)));
  };
  // tslint:disable-next-line:ban-types
  const on = (ee: NodeJS.EventEmitter, name: string, fn: any) => {
    ee.on(name, fn);
    disposables.push(toDisposable(() => ee.removeListener(name, fn)));
  };

  let encoding = options.encoding || "utf8";
  encoding = iconv.encodingExists(encoding) ? encoding : "utf8";

  const [exitCode, stdout, stderr] = await Promise.all<any>([
    new Promise<number>((c, e) => {
      once(child, "error", e);
      once(child, "exit", c);
    }),
    new Promise<string>((c) => {
      const buffers: Buffer[] = [];
      on(child.stdout, "data", (buf: Buffer) => buffers.push(buf));
      once(child.stdout, "close", () =>
        c(iconv.decode(Buffer.concat(buffers), encoding))
      );
    }),
    new Promise<string>((c) => {
      const buffers: Buffer[] = [];
      on(child.stderr, "data", (b: Buffer) => buffers.push(b));
      once(child.stderr, "close", () =>
        c(iconv.decode(Buffer.concat(buffers), encoding))
      );
    }),
  ]);

  dispose(disposables);
  return { exitCode, stdout, stderr };
}

/** 从 js Error 或者 IExecutionResult 或者 指定的 GIT code 的集合，用于创建 GitError */
export interface IGitErrorData {
  error?: Error;
  message?: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  gitErrorCode?: string;
  gitCommand?: string;
}

/** node-git 统一抛出的错误对象 */
export class GitError {
  public error?: Error;
  public message: string;
  public stdout?: string;
  public stderr?: string;
  public exitCode?: number;
  public gitErrorCode?: string;
  public gitCommand?: string;

  /** 从 js Error 或者 IExecutionResult 或者 指定的 GIT code 创建 GitError */
  constructor(data: IGitErrorData) {
    if (data.error) {
      this.error = data.error;
      this.message = data.error.message;
    } else {
      this.error = void 0;
    }

    this.message = this.message || data.message || "Git Error";
    this.stdout = data.stdout;
    this.stderr = data.stderr;
    this.exitCode = data.exitCode;
    this.gitErrorCode = data.gitErrorCode;
    this.gitCommand = data.gitCommand;
  }

  public toString(): string {
    let result =
      this.message +
      " " +
      JSON.stringify(
        {
          exitCode: this.exitCode,
          gitCommand: this.gitCommand,
          gitErrorCode: this.gitErrorCode,
          stderr: this.stderr,
          stdout: this.stdout,
        },
        [],
        2
      );

    if (this.error) {
      result += this.error.stack;
    }

    return result;
  }
}

/** 描述 git 二进制的信息 */
export interface IGitOptions {
  gitPath: string;
  version: string;
  env?: any;
}

/** 常见的 git 错误码 */
export const GitErrorCodes = {
  AuthenticationFailed: "AuthenticationFailed",
  BadConfigFile: "BadConfigFile",
  BranchNotFullyMerged: "BranchNotFullyMerged",
  CantAccessRemote: "CantAccessRemote",
  CantCreatePipe: "CantCreatePipe",
  CantOpenResource: "CantOpenResource",
  Conflict: "Conflict",
  DirtyWorkTree: "DirtyWorkTree",
  GitNotFound: "GitNotFound",
  LocalChangesOverwritten: "LocalChangesOverwritten",
  NoLocalChanges: "NoLocalChanges",
  NoRemoteReference: "NoRemoteReference",
  NoRemoteRepositorySpecified: "NoRemoteRepositorySpecified",
  NoStashFound: "NoStashFound",
  NoUserEmailConfigured: "NoUserEmailConfigured",
  NoUserNameConfigured: "NoUserNameConfigured",
  NotAGitRepository: "NotAGitRepository",
  NotAtRepositoryRoot: "NotAtRepositoryRoot",
  PushRejected: "PushRejected",
  RemoteConnectionError: "RemoteConnectionError",
  RepositoryIsLocked: "RepositoryIsLocked",
  RepositoryNotFound: "RepositoryNotFound",
  UnmergedChanges: "UnmergedChanges",
};

/** 从 stderr 找出 常见的 git 错误码，没找到就返回 undefined */
function getGitErrorCode(stderr: string): string | undefined {
  // tslint:disable-next-line:max-line-length
  if (
    /Another git process seems to be running in this repository|If no other git process is currently running/.test(
      stderr
    )
  ) {
    return GitErrorCodes.RepositoryIsLocked;
  } else if (/Authentication failed/.test(stderr)) {
    return GitErrorCodes.AuthenticationFailed;
  } else if (/Not a git repository/.test(stderr)) {
    return GitErrorCodes.NotAGitRepository;
  } else if (/bad config file/.test(stderr)) {
    return GitErrorCodes.BadConfigFile;
  } else if (
    /cannot make pipe for command substitution|cannot create standard input pipe/.test(
      stderr
    )
  ) {
    return GitErrorCodes.CantCreatePipe;
  } else if (/Repository not found/.test(stderr)) {
    return GitErrorCodes.RepositoryNotFound;
  } else if (/unable to access/.test(stderr)) {
    return GitErrorCodes.CantAccessRemote;
  } else if (/branch '.+' is not fully merged/.test(stderr)) {
    return GitErrorCodes.BranchNotFullyMerged;
  } else if (/Couldn\'t find remote ref/.test(stderr)) {
    return GitErrorCodes.NoRemoteReference;
  }
  return void 0;
}

/** 对 Git 的封装 */
export class Git {
  private gitPath: string;
  private version: string;
  private env: any;

  private _onOutput = new EventEmitter();
  get onOutPut(): EventEmitter {
    return this._onOutput;
  }

  constructor(options: IGitOptions) {
    this.gitPath = options.gitPath;
    this.version = options.version;
    this.env = options.env || {};
  }

  public open(repository: string): Repository {
    return new Repository(this, repository);
  }

  public async init(repository: string): Promise<void> {
    await this.exec(repository, ["init"]);
  }

  public async clone(url: string, parentPath: string): Promise<string> {
    const folderName =
      decodeURI(url)
        .replace(/^.*\//, "")
        .replace(/\.git$/, "") || "repository";
    const folderPath = path.join(parentPath, folderName);

    await mkdirp(parentPath);
    await this.exec(parentPath, ["clone", url, folderPath]);
    return folderPath;
  }

  public async config(
    key: string,
    value: any,
    options: any = {}
  ): Promise<string> {
    const args = ["config"];
    args.push(`--global`);
    args.push(key);

    if (value) {
      args.push(value);
    }

    const result = await this._exec(args, options);
    return result.stdout;
  }

  // tslint:disable-next-line:no-shadowed-variable
  public async getRepositoryRoot(path: string): Promise<string> {
    const result = await this.exec(path, ["rev-parse", "--show-toplevel"]);
    return result.stdout.trim();
  }

  public async exec(
    cwd: string,
    args: string[],
    options: any = {}
  ): Promise<IExecutionResult> {
    options = assign({ cwd }, options || {});
    return await this._exec(args, options);
  }

  public spawn(args: string[], options: any = {}): cp.ChildProcess {
    if (!this.gitPath) {
      throw new Error("git could not be found in the system.");
    }

    if (!options) {
      options = {};
    }

    if (!options.stdio && !options.input) {
      // Unless provided, ignore stdin and leave default streams for stdout and stderr
      options.stdio = ["ignore", null, null];
    }

    options.env = assign({}, process.env, this.env, options.env || {}, {
      LANG: "en_US.UTF-8",
      LC_ALL: "en_US.UTF-8",
      VSCODE_GIT_COMMAND: args[0],
    });

    if (options.log !== false) {
      this.log(`git ${args.join(" ")}\n`);
    }

    return cp.spawn(this.gitPath, args, options);
  }

  public stream(
    cwd: string,
    args: string[],
    options: any = {}
  ): cp.ChildProcess {
    options = assign({ cwd }, options || {});
    return this.spawn(args, options);
  }

  private async _exec(
    args: string[],
    options: any = {}
  ): Promise<IExecutionResult> {
    const child = this.spawn(args, options);

    if (options.input) {
      child.stdin.end(options.input, "utf8");
    }

    const result = await exec(child, options);

    if (options.log !== false && result.stderr.length > 0) {
      this.log(`${result.stderr}\n`);
    }

    if (result.exitCode) {
      return Promise.reject<IExecutionResult>(
        new GitError({
          exitCode: result.exitCode,
          gitCommand: args[0],
          gitErrorCode: getGitErrorCode(result.stderr),
          message: "Failed to execute git",
          stderr: result.stderr,
          stdout: result.stdout,
        })
      );
    }

    return result;
  }

  private log(output: string): void {
    this._onOutput.emit("log", output);
  }
}

/** 对 commit log 中每一个 commit 的抽象 */
export interface ICommit {
  hash: string;
  message: string;
}
/** 用于解析 git status 结果 */
export class GitStatusParser {
  private lastRaw = "";
  private result: IFileStatus[] = [];

  get status(): IFileStatus[] {
    return this.result;
  }

  public update(raw: string): void {
    let i = 0;
    let nextI: number | undefined;

    raw = this.lastRaw + raw;

    // tslint:disable-next-line:no-conditional-assignment
    while ((nextI = this.parseEntry(raw, i)) !== undefined) {
      i = nextI;
    }

    this.lastRaw = raw.substr(i);
  }

  private parseEntry(raw: string, i: number): number | undefined {
    if (i + 4 >= raw.length) {
      return;
    }

    let lastIndex: number;
    const entry: IFileStatus = {
      path: "",
      rename: undefined,
      x: raw.charAt(i++),
      y: raw.charAt(i++),
    };

    // space
    i++;

    if (entry.x === "R" || entry.x === "C") {
      lastIndex = raw.indexOf("\0", i);

      if (lastIndex === -1) {
        return;
      }

      entry.rename = raw.substring(i, lastIndex);
      i = lastIndex + 1;
    }

    lastIndex = raw.indexOf("\0", i);

    if (lastIndex === -1) {
      return;
    }

    entry.path = raw.substring(i, lastIndex);

    // If path ends with slash, it must be a nested git repo
    if (entry.path[entry.path.length - 1] !== "/") {
      this.result.push(entry);
    }

    return lastIndex + 1;
  }
}

/** 对 Git Repo 操作的封装 */
export class Repository {
  constructor(private _git: Git, private repositoryRoot: string) {}

  get git(): Git {
    return this._git;
  }

  get root(): string {
    return this.repositoryRoot;
  }

  public async run(
    args: string[],
    options: any = {}
  ): Promise<IExecutionResult> {
    return await this.git.exec(this.repositoryRoot, args, options);
  }

  protected stream(args: string[], options: any = {}): cp.ChildProcess {
    return this.git.stream(this.repositoryRoot, args, options);
  }

  protected spawn(args: string[], options: any = {}): cp.ChildProcess {
    return this.git.spawn(args, options);
  }
  public init(): Promise<void> {
    return this._git.init(this.repositoryRoot);
  }

  async getCurrentRemote(options: any = {}): Promise<string> {
    const branch = await this.getHEAD();
    const args = ["config", `branch.${branch.name}.remote`];
    const result = await this.run(args, options);
    return result.stdout.trim();
  }

  async configGet(
    scope: string,
    key: string,
    options: any = {}
  ): Promise<string> {
    const args = ["config"];

    if (scope) {
      args.push(`--${scope}`);
    }

    args.push("--get");

    args.push(key);

    const result = await this.run(args, options);
    return result.stdout.trim();
  }

  /**
   * change git config
   * @param scope     [global, system, local]
   * @param key       config key, e.g. user.name
   * @param value     config value, e.g. 'zhang san'
   * @param options   nodejs/child_process exec option, not git option.
   * @returns string  stdout
   */
  public async config(
    scope: string,
    key: string,
    value: any,
    options: any
  ): Promise<string> {
    const args = ["config"];

    if (scope) {
      args.push(`--${scope}`);
    }

    args.push(key);

    if (value) {
      args.push(value);
    }

    const result = await this.run(args, options);
    return result.stdout;
  }

  protected async buffer(
    object: string,
    encoding: string = "utf8"
  ): Promise<string> {
    const child = this.stream(["show", object]);
    if (!child.stdout) {
      return Promise.reject<string>("Can't open file from git.");
    }

    const { exitCode, stdout } = await exec(child, { encoding });

    if (exitCode) {
      return Promise.reject<string>(
        new GitError({
          exitCode,
          message: "Could not show object.",
        })
      );
    }

    return stdout;
  }

  public sshow(object: string): cp.ChildProcess {
    return this.stream(["show", object]);
  }

  public async show(filePath: string, treeish?: string): Promise<string> {
    treeish = !treeish || treeish === "~" ? "" : treeish;
    try {
      return await this.buffer(treeish + ":" + filePath);
    } catch (e) {
      if (e instanceof GitError) {
        return "";
      }
      throw e;
    }
  }

  /**
   * git add
   * @param paths 添加的文件路径（相对于 repo 根目录）支持文件夹或者通配符
   */
  public async add(paths: string[]): Promise<void> {
    const args = ["add", "-A", "--"];

    if (paths && paths.length) {
      args.push.apply(args, paths);
    } else {
      args.push(".");
    }
    await this.run(args);
  }

  /**
   * 不修改文件的基础上，直接将内容存进 git stage， 慎用。
   * @param path
   * @param data
   */
  // tslint:disable-next-line:no-shadowed-variable
  public async stage(path: string, data: string): Promise<void> {
    const child = this.stream(
      ["hash-object", "--stdin", "-w", "--path", path],
      { stdio: [null, null, null] }
    );
    child.stdin.end(data, "utf8");

    const { exitCode, stdout } = await exec(child);

    if (exitCode) {
      throw new GitError({
        exitCode,
        message: "Could not hash object.",
      });
    }
    await this.run(["update-index", "--cacheinfo", "100644", stdout, path]);
  }

  /**
   * git checkout， treeish 和 paths 两者中必传一个，另一个使用 ‘’/[]。 切换版本 或 检出文件
   * @param treeish branch || commit || tag || 相对ref, e.g. HEAD~2
   * @param paths   文件、文件夹路径或通配符路径
   */
  public async checkout(treeish: string, paths: string[]): Promise<void> {
    const args = ["checkout", "-q"];
    if (treeish) {
      args.push(treeish);
    }
    if (paths && paths.length) {
      args.push("--");
      args.push.apply(args, paths);
    }
    try {
      await this.run(args);
    } catch (err) {
      if (/Please, commit your changes or stash them/.test(err.stderr) || "") {
        err.gitErrorCode = GitErrorCodes.DirtyWorkTree;
      }
      throw err;
    }
  }
  /**
   * commit
   * @param message           commit 信息
   * @param opts.all          添加所有 not staged 的文件
   * @param opts.amend        补充上次提交
   * @param opts.signoff      署名
   * @param opts.signCommit   使用 GPG 秘钥来署名
   */
  // tslint:disable-next-line:max-line-length
  public async commit(
    message: string,
    opts: {
      all?: boolean;
      amend?: boolean;
      signoff?: boolean;
      signCommit?: boolean;
    } = Object.create(null)
  ): Promise<void> {
    const args = ["commit", "--quiet", "--allow-empty-message", "--file", "-"];

    if (opts.all) {
      args.push("--all");
    }

    if (opts.amend) {
      args.push("--amend");
    }

    if (opts.signoff) {
      args.push("--signoff");
    }

    if (opts.signCommit) {
      args.push("-S");
    }

    try {
      await this.run(args, { input: message || "" });
    } catch (commitErr) {
      if (
        /not possible because you have unmerged files/.test(
          commitErr.stderr || ""
        )
      ) {
        commitErr.gitErrorCode = GitErrorCodes.UnmergedChanges;
        throw commitErr;
      }

      try {
        await this.run(["config", "--get-all", "user.name"]);
      } catch (err) {
        err.gitErrorCode = GitErrorCodes.NoUserNameConfigured;
        throw err;
      }

      try {
        await this.run(["config", "--get-all", "user.email"]);
      } catch (err) {
        err.gitErrorCode = GitErrorCodes.NoUserEmailConfigured;
        throw err;
      }

      throw commitErr;
    }
  }

  /**
   * 新建 分支
   * @param name      分支名字
   * @param checkout  是否立刻切换到新分支上
   */
  public async branch(name: string, checkout: boolean): Promise<void> {
    const args = checkout
      ? ["checkout", "-q", "-b", name]
      : ["branch", "-q", name];
    await this.run(args);
  }

  /**
   * 删除分支，如果分支没合并到其他分支上，普通删除会抛出异常。
   * @param name      分支名字
   * @param force     没合并的也强制删除
   */
  public async deleteBranch(name: string, force?: boolean): Promise<void> {
    const args = ["branch", force ? "-D" : "-d", name];
    await this.run(args);
  }

  /**
   * 合并，遇到冲突会抛出异常
   * @param ref 要合并到当前分支的 ref， 可以是 commit id || branch || tag 等
   * @throws GitError { gitErrorCode: GitErrorCodes.Conflict }
   */
  public async merge(ref: string): Promise<void> {
    const args = ["merge", ref];

    try {
      await this.run(args);
    } catch (err) {
      if (/^CONFLICT /m.test(err.stdout || "")) {
        err.gitErrorCode = GitErrorCodes.Conflict;
      }

      throw err;
    }
  }

  /**
   * 给当前的 HEAD 打 tag
   * @param name      tag 名字
   * @param message   tag 的 message
   */
  public async tag(name: string, message?: string): Promise<void> {
    let args = ["tag"];

    if (message) {
      args = [...args, "-a", name, "-m", message];
    } else {
      args = [...args, name];
    }

    await this.run(args);
  }

  /**
   * Remove untracked files from the working tree
   * @param paths     要移除的文件或文件夹或通配符路径
   */
  public async clean(paths: string[]): Promise<void> {
    const pathsByGroup = groupBy(paths, (p) => path.dirname(p));
    const groups = Object.keys(pathsByGroup).map((k) => pathsByGroup[k]);
    const tasks = groups.map(
      (_paths) => () => this.run(["clean", "-f", "-q", "--"].concat(_paths))
    );

    for (const task of tasks) {
      await task();
    }
  }

  /**
   * 清理整个repo 目录下所有 未跟踪的文件 和 未暂存的修改
   * 即 git clean -fd && git checkout -- .
   */
  public async undo(): Promise<void> {
    await this.run(["clean", "-fd"]);

    try {
      await this.run(["checkout", "--", "."]);
    } catch (err) {
      if (/did not match any file\(s\) known to git\./.test(err.stderr || "")) {
        return;
      }

      throw err;
    }
  }

  /**
   * 重置 HEAD 到指定的提交
   * @param treeish   branch || tag || 相对名称 || commit id
   * @param hard      硬回滚，缓存区和工作目录都同步到你指定的提交，否则不影响工作目录
   */
  public async reset(treeish: string, hard: boolean = false): Promise<void> {
    const args = ["reset"];

    if (hard) {
      args.push("--hard");
    }

    args.push(treeish);

    await this.run(args);
  }

  /**
   * 撤销已经放入暂存区的修改
   * @param treeish   branch || tag || 相对名称 || commit id ， repo HEAD 指向某一分支时有效，将指定ref的某些文件检出到工作区。 用于重置暂存区是使用 HEAD
   * @param paths     文件、文件夹路径，支持通配符，传空数组 == ['.']
   */
  public async revert(treeish: string, paths: string[]): Promise<void> {
    const result = await this.run(["branch"]);
    let args: string[];

    // In case there are no branches, we must use rm --cached
    if (!result.stdout) {
      args = ["rm", "--cached", "-r", "--"];
    } else {
      args = ["reset", "-q", treeish, "--"];
    }

    if (paths && paths.length) {
      args.push.apply(args, paths);
    } else {
      args.push(".");
    }

    try {
      await this.run(args);
    } catch (err) {
      // In case there are merge conflicts to be resolved, git reset will output
      // some "needs merge" data. We try to get around that.
      if (/([^:]+: needs merge\n)+/m.test(err.stdout || "")) {
        return;
      }

      throw err;
    }
  }

  /**
   * 同步远端的数据到本地
   */
  public async fetch(): Promise<void> {
    try {
      await this.run(["fetch"]);
    } catch (err) {
      if (/No remote repository specified\./.test(err.stderr || "")) {
        err.gitErrorCode = GitErrorCodes.NoRemoteRepositorySpecified;
      } else if (
        /Could not read from remote repository/.test(err.stderr || "")
      ) {
        err.gitErrorCode = GitErrorCodes.RemoteConnectionError;
      }

      throw err;
    }
  }

  /**
   * Fetch from and integrate with another repository or a local branch
   * @param rebase 是否使用 rebase 方式合并提交
   * @param remote 指定的远端，需要和 branch 同时使用
   * @param branch 指定的分支，需要和 remote 同时使用
   * @throws GitError Conflict || NoUserNameConfigured || RemoteConnectionError || DirtyWorkTree
   */
  public async pull(
    rebase?: boolean,
    remote?: string,
    branch?: string
  ): Promise<void> {
    const args = ["pull"];

    if (rebase) {
      args.push("-r");
    }

    if (remote && branch) {
      args.push(remote);
      args.push(branch);
    }

    try {
      await this.run(args);
    } catch (err) {
      if (/^CONFLICT \([^)]+\): \b/m.test(err.stdout || "")) {
        err.gitErrorCode = GitErrorCodes.Conflict;
      } else if (/Please tell me who you are\./.test(err.stderr || "")) {
        err.gitErrorCode = GitErrorCodes.NoUserNameConfigured;
      } else if (
        /Could not read from remote repository/.test(err.stderr || "")
      ) {
        err.gitErrorCode = GitErrorCodes.RemoteConnectionError;
        // tslint:disable-next-line:max-line-length
      } else if (
        /Pull is not possible because you have unmerged files|Cannot pull with rebase: You have unstaged changes|Your local changes to the following files would be overwritten|Please, commit your changes before you can merge/.test(
          err.stderr
        )
      ) {
        err.gitErrorCode = GitErrorCodes.DirtyWorkTree;
      }

      throw err;
    }
  }

  /**
   * 推送本地数据到远端
   * @param remote        指定的远端
   * @param name          分支名字，不指定则推送所有
   * @param setUpstream   设置 upstream
   * @param tags          推送 tag
   * @throws GitError     PushRejected || RemoteConnectionError
   */
  public async push(
    remote?: string,
    name?: string,
    setUpstream: boolean = false,
    tags = false
  ): Promise<void> {
    const args = ["push"];

    if (setUpstream) {
      args.push("-u");
    }

    if (tags) {
      args.push("--tags");
    }

    if (remote) {
      args.push(remote);
    }

    if (name) {
      args.push(name);
    }

    try {
      await this.run(args);
    } catch (err) {
      if (/^error: failed to push some refs to\b/m.test(err.stderr || "")) {
        err.gitErrorCode = GitErrorCodes.PushRejected;
      } else if (
        /Could not read from remote repository/.test(err.stderr || "")
      ) {
        err.gitErrorCode = GitErrorCodes.RemoteConnectionError;
      }

      throw err;
    }
  }

  /**
   * 创建贮存
   * @param message       msg
   * @throws GitError     NoLocalChanges
   */
  public async createStash(message?: string): Promise<void> {
    try {
      const args = ["stash", "save"];

      if (message) {
        args.push("--", message);
      }

      await this.run(args);
    } catch (err) {
      if (/No local changes to save/.test(err.stderr || "")) {
        err.gitErrorCode = GitErrorCodes.NoLocalChanges;
      }

      throw err;
    }
  }

  /**
   * 将贮存区贮存的修改应用到当前工作区
   * @param index         贮存弹栈的层数
   * @throws GitError     NoStashFound || LocalChangesOverwritten
   */
  public async popStash(index?: number): Promise<void> {
    try {
      const args = ["stash", "pop"];

      if (typeof index === "string") {
        args.push(`stash@{${index}}`);
      }

      await this.run(args);
    } catch (err) {
      if (/No stash found/.test(err.stderr || "")) {
        err.gitErrorCode = GitErrorCodes.NoStashFound;
      } else if (
        /error: Your local changes to the following files would be overwritten/.test(
          err.stderr || ""
        )
      ) {
        err.gitErrorCode = GitErrorCodes.LocalChangesOverwritten;
      }

      throw err;
    }
  }

  /**
   * 查看当前工作区的文件状态
   * @param limit 文件变动状态 数量限制
   * @throws GitError
   */
  public getStatus(
    limit = 5000
  ): Promise<{ status: IFileStatus[]; didHitLimit: boolean }> {
    return new Promise<{ status: IFileStatus[]; didHitLimit: boolean }>(
      (c, e) => {
        const parser = new GitStatusParser();
        const child = this.stream(["status", "-z", "-u"]);

        const onExit = (exitCode: number) => {
          if (exitCode !== 0) {
            const stderr = stderrData.join("");
            return e(
              new GitError({
                exitCode,
                gitCommand: "status",
                gitErrorCode: getGitErrorCode(stderr),
                message: "Failed to execute git",
                stderr,
              })
            );
          }

          c({ status: parser.status, didHitLimit: false });
        };

        const onStdoutData = (raw: string) => {
          parser.update(raw);

          if (parser.status.length > limit) {
            child.removeListener("exit", onExit);
            child.stdout.removeListener("data", onStdoutData);
            child.kill();

            c({ status: parser.status.slice(0, limit), didHitLimit: true });
          }
        };

        child.stdout.setEncoding("utf8");
        child.stdout.on("data", onStdoutData);

        const stderrData: string[] = [];
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (raw) => stderrData.push(raw as string));

        child.on("error", e);
        child.on("exit", onExit);
      }
    );
  }

  /**
   * 获取当前 HEAD 位置，branch name || commit id
   */
  public async getHEAD(): Promise<IRef> {
    try {
      const result = await this.run(["symbolic-ref", "--short", "HEAD"]);

      if (!result.stdout) {
        throw new Error("Not in a branch");
      }

      return { name: result.stdout.trim(), commit: void 0, type: RefType.Head };
    } catch (err) {
      const result = await this.run(["rev-parse", "HEAD"]);

      if (!result.stdout) {
        throw new Error("Error parsing HEAD");
      }

      return { name: void 0, commit: result.stdout.trim(), type: RefType.Head };
    }
  }

  /**
   * 获取 ref ，包含 本地的 分支和tag，远端的分支
   */
  public async getRefs(): Promise<IRef[]> {
    const result = await this.run([
      "for-each-ref",
      "--format",
      "%(refname) %(objectname)",
    ]);

    const fn = (line: string): IRef | null => {
      let match: RegExpExecArray | null;

      // tslint:disable-next-line:no-conditional-assignment
      if ((match = /^refs\/heads\/([^ ]+) ([0-9a-f]{40})$/.exec(line))) {
        return { name: match[1], commit: match[2], type: RefType.Head };
        // tslint:disable-next-line:no-conditional-assignment
      } else if (
        (match = /^refs\/remotes\/([^/]+)\/([^ ]+) ([0-9a-f]{40})$/.exec(line))
      ) {
        // tslint:disable-next-line:max-line-length
        return {
          name: `${match[1]}/${match[2]}`,
          commit: match[3],
          type: RefType.RemoteHead,
          remote: match[1],
        };
        // tslint:disable-next-line:no-conditional-assignment
      } else if ((match = /^refs\/tags\/([^ ]+) ([0-9a-f]{40})$/.exec(line))) {
        return { name: match[1], commit: match[2], type: RefType.Tag };
      }

      return null;
    };

    return result.stdout
      .trim()
      .split("\n")
      .filter((line) => !!line)
      .map(fn)
      .filter((ref) => !!ref) as IRef[];
  }

  /**
   * 获取贮藏区的贮藏列表
   */
  public async getStashes(): Promise<Stash[]> {
    const result = await this.run(["stash", "list"]);
    const regex = /^stash@{(\d+)}:(.+)$/;
    const rawStashes = result.stdout
      .trim()
      .split("\n")
      .filter((b) => !!b)
      .map((line) => regex.exec(line))
      .filter((g) => !!g)
      .map(([, index, description]: RegExpExecArray) => ({
        index: parseInt(index, 10),
        description,
      }));

    return rawStashes;
  }

  /**
   * 获取 repo 的所有的远端信息
   */
  public async getRemotes(): Promise<IRemote[]> {
    const result = await this.run(["remote", "--verbose"]);
    const regex = /^([^\s]+)\s+([^\s]+)\s/;
    const rawRemotes = result.stdout
      .trim()
      .split("\n")
      .filter((b) => !!b)
      .map((line) => regex.exec(line))
      .filter((g) => !!g)
      .map((groups: RegExpExecArray) => ({ name: groups[1], url: groups[2] }));

    return uniqBy(rawRemotes, (remote) => remote.name);
  }

  /**
   * 获取分支信息
   * @param name 分支名字
   * @throws Error No such branch
   */
  // TODO any bugs?
  public async getBranch(name: string): Promise<IBranch> {
    if (name === "HEAD") {
      return this.getHEAD();
    }

    const result = await this.run(["rev-parse", name]);

    if (!result.stdout) {
      return Promise.reject<IBranch>(new Error("No such branch"));
    }

    const commit = result.stdout.trim();

    try {
      const res2 = await this.run([
        "rev-parse",
        "--symbolic-full-name",
        "--abbrev-ref",
        name + "@{u}",
      ]);
      const upstream = res2.stdout.trim();

      const res3 = await this.run([
        "rev-list",
        "--left-right",
        name + "..." + upstream,
      ]);

      let ahead = 0;
      let behind = 0;
      let i = 0;

      while (i < res3.stdout.length) {
        switch (res3.stdout.charAt(i)) {
          case "<":
            ahead++;
            break;
          case ">":
            behind++;
            break;
          default:
            i++;
            break;
        }

        while (res3.stdout.charAt(i++) !== "\n") {
          /* no-op */
        }
      }

      return { name, type: RefType.Head, commit, upstream, ahead, behind };
    } catch (err) {
      return { name, type: RefType.Head, commit };
    }
  }

  /**
   * 获取提交模版
   */
  public async getCommitTemplate(): Promise<string> {
    try {
      const result = await this.run(["config", "--get", "commit.template"]);

      if (!result.stdout) {
        return "";
      }

      // https://github.com/git/git/blob/3a0f269e7c82aa3a87323cb7ae04ac5f129f036b/path.c#L612
      const homedir = os.homedir();
      let templatePath = result.stdout
        .trim()
        .replace(
          /^~([^\/]*)\//,
          (_, user) =>
            `${user ? path.join(path.dirname(homedir), user) : homedir}/`
        );

      if (!path.isAbsolute(templatePath)) {
        templatePath = path.join(this.repositoryRoot, templatePath);
      }

      const raw = await readfile(templatePath, "utf8");
      return raw.replace(/^\s*#.*$\n?/gm, "").trim();
    } catch (err) {
      return "";
    }
  }

  /**
   * 获取 commit id 和 message
   * @param ref commit id || branch || tag || 相对HEAD
   */
  public async getCommit(ref: string): Promise<ICommit> {
    const result = await this.run(["show", "-s", "--format=%H\n%B", ref]);
    const match = /^([0-9a-f]{40})\n([^]*)$/m.exec(result.stdout.trim());

    if (!match) {
      return Promise.reject<ICommit>("bad commit format");
    }

    return { hash: match[1], message: match[2] };
  }

  /**
   * 获取指定版本的某个文件内容
   * @param ref commit id || branch || tag || 相对HEAD
   * @param path 文件路径
   * @throws Error 文件不存在
   */
  public async getFile(ref: string, path: string): Promise<string> {
    const out = await this.buffer(`${ref}:${path}`);
    return out;
  }

  /**
   *
   * @param _path                 指定文件、文件夹路径
   * @param opts.all              获取所有分支，默认只获取当前分支的历史记录
   * @param opts.limit            最大历史记录获取数量
   * @param opts.encoding         传递给 node／child_process
   * @throws Error || GitError    Could not show logs || Can't get commit logs
   */
  // tslint:disable-next-line:max-line-length
  public async log(
    _path: string = ".",
    opts: { encoding?: string; all?: boolean; limit?: number } = {}
  ): Promise<IGitLog[]> {
    // tslint:disable-next-line:max-line-length
    const args = [
      "log",
      "--format=####%ncommitid: %H%nparentid: %P%nauthor: %aN%ndate: %aI%nsubject: %s%n####%n",
    ];
    if (opts.all) {
      args.push("--all");
    }
    if (opts.limit) {
      args.push("-n", opts.limit.toString());
    }
    if (_path) {
      args.push(_path);
    }
    const child = this.stream(args);
    if (!child.stdout) {
      return Promise.reject<IGitLog[]>("Can't get commit logs.");
    }

    const { exitCode, stdout } = await exec(child, { encoding: opts.encoding });

    if (exitCode) {
      return Promise.reject<IGitLog[]>(
        new GitError({
          exitCode,
          message: "Could not show logs.",
        })
      );
    }
    const parse = new GitLogParse();
    parse.update(stdout);
    return parse.logs;
  }

  /**
   * 获取远端的 ref, 默认获取 branch + tag
   * @param opts.branch   是否获取 branch
   * @param opts.tag      是否获取 tag
   * @param opts.encoding node/child_process
   */
  // tslint:disable-next-line:max-line-length
  public async getRemoteRefs(
    opts: { branch?: boolean; tag?: boolean; encoding?: string } = {
      encoding: "utf8",
    }
  ): Promise<IRef[]> {
    const args = ["ls-remote", "--refs"];
    if (!opts.branch) {
      args.push("--tags");
    }
    if (!opts.tag) {
      args.push("--heads");
    }
    const child = this.stream(args);
    if (!child.stdout) {
      return Promise.reject<IRef[]>("Can't get remote refs.");
    }

    const { exitCode, stdout } = await exec(child, { encoding: opts.encoding });
    const refs = [];
    const re = /^([0-9a-f]{40})\s+(.+)$/gm;
    const type_table = {
      heads: RefType.RemoteHead,
      tags: RefType.RemoteTag,
    };
    while (1) {
      const res = re.exec(stdout);
      if (res) {
        const [_, commit, ref_str] = res;
        const [__, type, name] = ref_str.split("/", 3);
        refs.push({
          commit,
          name,
          type: type_table[type],
        });
      } else {
        break;
      }
    }
    if (exitCode) {
      return Promise.reject<IRef[]>(
        new GitError({
          exitCode,
          message: "Could not show remote refs.",
        })
      );
    }
    return refs;
  }

  /**
   * 获取远端的 ref, 默认获取 branch + tag
   * @param opts.branch   是否获取 branch
   * @param opts.tag      是否获取 tag
   * @param opts.encoding node/child_process
   */
  // tslint:disable-next-line:max-line-length
  public async getLocalRefs(
    opts: {
      head?: boolean;
      branch?: boolean;
      tag?: boolean;
      encoding?: string;
    } = { encoding: "utf8" }
  ): Promise<IRef[]> {
    const args = ["show-ref"];
    if (opts.head) {
      args.push("--head");
    }
    if (opts.branch) {
      args.push("--heads");
    }
    if (opts.tag) {
      args.push("--tags");
    }
    const child = this.stream(args);
    if (!child.stdout) {
      return Promise.reject<IRef[]>("Can't get local ref.");
    }

    const { exitCode, stdout } = await exec(child, { encoding: opts.encoding });
    const refs = [];
    const re = /^([0-9a-f]{40})\s+(.+)$/gm;
    const type_table = {
      heads: RefType.Head,
      tags: RefType.Tag,
    };
    let __;
    let type;
    let name;
    let name2;
    while (1) {
      const res = re.exec(stdout);
      if (res) {
        const [_, commit, ref_str] = res;
        if (ref_str === "HEAD") {
          [type, name] = ["heads", "HEAD"];
        } else {
          [__, type, name, name2] = ref_str.split("/", 4);
        }
        refs.push({
          commit,
          name: name2 ? `${name}/${name2}` : name,
          type: type_table[type],
        });
      } else {
        break;
      }
    }
    if (exitCode) {
      return Promise.reject<IRef[]>(
        new GitError({
          exitCode,
          message: "Could not show local ref.",
        })
      );
    }
    return refs;
  }
}

/** 用于解析 git log 结果 */
export class GitLogParse {
  private result: IGitLog[];
  // tslint:disable-next-line:max-line-length
  private re =
    /####\r?\ncommitid: ([0-9a-f]{40})\r?\nparentid: ([0-9a-f]{40}) ?([0-9a-f]{40})?\r?\nauthor: (.+)\r?\ndate: (.+)\r?\nsubject: (.+)\r?\n####(?:\r?\n)*/g;
  private buf: string;
  constructor() {
    this.result = [];
    this.buf = "";
  }
  public get logs() {
    return this.result;
  }
  public update(raw: string): void {
    const _raw = this.buf + raw;
    while (1) {
      const res = this.re.exec(raw);
      if (res) {
        const [_, commit_id, parent_id_1, parent_id_2, author, date, subject] =
          res;
        this.result.push({
          author,
          commit: commit_id,
          date: new Date(date),
          isMerged: !!parent_id_2,
          message: subject,
          parents: !!parent_id_2 ? [parent_id_1, parent_id_2] : [parent_id_1],
        });
      } else {
        this.buf = _raw.slice(this.re.lastIndex);
        this.re.lastIndex = 0;
        break;
      }
    }
  }
}
