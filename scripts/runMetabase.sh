#!/bin/bash

docker rm metabase
docker run -i -d -p 3000:3000 --name metabase -v "$PWD/data/metabase.db:/metabase.db" -v "$PWD/data/stats.db:/opt/ytwl.db" -e MUID="$UID" -e MGID="$GID" metabase/metabase
xdg-open http://localhost:3000
