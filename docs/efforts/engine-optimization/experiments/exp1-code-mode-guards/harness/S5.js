const EFF='/private/tmp/claude-501/cmx-lab/effects.log';
await $('echo S5_1 >> '+EFF);
await $('sleep 45; echo S5_2 >> '+EFF);
await $('echo S5_3 >> '+EFF);
await write('lab/s5.txt','S5_4 written');
return 'finished';
