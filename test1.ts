import * as path from "path";
import * as cp from "child_process";
import { Git, findGit, Repository } from "./src/git-new/git-shell";

const checkForLocalConfig = async () => {
  const gitConf = await findGit(undefined);
  const git = new Git({ gitPath: gitConf.path, version: gitConf.version });
  const repository = new Repository(
    git,
    "/Users/orange/code/gitee/chrome-extension/Workspace-Bookmark"
  );
  const a = await repository.getCurrentRemote();
  // const remotes = await repository.getHEAD();
  // const asdf = await repository.run([
  //   "config",
  //   `branch.${remotes.name}.remote`,
  // ]);
  console.log(`xjf: `, a);
};

checkForLocalConfig();
