import { readConfig } from '../src/config.js';
import { runFinishInstallation, finishOwnerConnection } from '../src/mcp/finish-installation.js';

try{const config=readConfig();console.log(JSON.stringify(await runFinishInstallation(config,process.argv.slice(2),{ownerUrl:await finishOwnerConnection(config)})));}
catch{console.error('Finish storage installation failed. Check the reviewed database/origin/tenant contract and private backup.');process.exitCode=1;}
