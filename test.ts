import * as path from "path";
import * as cp from "child_process";

export interface IDisposable {
  dispose(): void;
}
export interface IExecutionResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}
export async function exec(child: cp.ChildProcess): Promise<any> {
  const once = (ee: NodeJS.EventEmitter, name: string, fn: Function) => {
    ee.once(name, fn);
  };

  const on = (ee: NodeJS.EventEmitter, name: string, fn: Function) => {
    ee.on(name, fn);
  };

  const [exitCode, stdout, stderr] = await Promise.all<any>([
    new Promise<number>((c, e) => {
      once(child, "error", e);
      once(child, "exit", c);
    }),
    new Promise<string>((c) => {
      const buffers: string[] = [];
      on(child.stdout, "data", (b: string) => buffers.push(b));
      once(child.stdout, "close", () => c(buffers.join("")));
    }),
    new Promise<string>((c) => {
      const buffers: string[] = [];
      on(child.stderr, "data", (b: string) => buffers.push(b));
      once(child.stderr, "close", () => c(buffers.join("")));
    }),
  ]);
}

const env = Object.assign(
  {},
  process.env,
  {},
  {
    LANG: "en_US.UTF-8",
  }
);
(async () => {
  const child = cp.spawn("/usr/bin/git", ["rev-parse", "--show-toplevel"], {
    cwd: "/Users/orange/code/gh",
  });
  child.stdout.on("data", (data) => {
    console.log(`stdout: ${data}`);
  });

  child.stderr.on("data", (data) => {
    console.error(`stderr: ${data}`);
  });

  child.on("close", (code) => {
    console.log(`child process exited with code ${code}`);
  });
  // const result = await exec(child);
  // console.log(`xjf: `, result);
})();
