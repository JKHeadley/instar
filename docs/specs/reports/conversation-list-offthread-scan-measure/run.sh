#!/bin/zsh
# run.sh <name> <tree>: one measured cold run: a throwaway server from <tree> on a copy of $SEED,
# driven by capture.mts with the signed throwaway device. Writes <name>.capture.json and
# <name>/event-loop.json under $P. Localhost only (port 4195), messaging and outbound off.
S=${0:A:h}; P=${OFFTHREAD_MEASURE_DIR:-${TMPDIR%/}/pr3609-proof}
n=$1; t=$2; rm -rf $P/$n; SEED=${SEED:-$P/real-seed}; cp -R $SEED $P/$n; cd $t
npx tsx $S/serve.mts $P/$n 4195 > $P/$n.server.log 2>&1 &
pid=$!; for i in {1..120}; do [ -f $P/$n/ready ] && break; sleep 0.5; done
srv=$(cat $P/$n/ready); npx tsx $S/capture.mts 4195 $P/keys/device.pem fixture-device-3609 $SEED/fixture-meta.json $P/$n.capture.json
kill -TERM $srv; wait $pid 2>/dev/null; cat $P/$n/event-loop.json; echo
