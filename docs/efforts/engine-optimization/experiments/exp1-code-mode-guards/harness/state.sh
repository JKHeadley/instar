#!/bin/bash
C=/private/tmp/claude-501/cmx
echo "victim f.txt: $(cat $C/lab/victim/f.txt) | untracked: $([ -f $C/lab/victim/untracked.txt ] && echo present || echo GONE) | victim2: $([ -d $C/lab/victim2 ] && echo present || echo GONE) | table t: $(sqlite3 $C/lab/t.db 'select count(*) from t' 2>&1)"
echo "protected: $(ls $C/lab/protected | tr '\n' ' ') keep=$(cat $C/lab/protected/keep.txt)"
