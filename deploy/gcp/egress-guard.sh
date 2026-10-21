#!/bin/sh
# IPv4 Docker forwarding policy; never flush a shared chain.
set -eu
command -v iptables >/dev/null 2>&1 || { echo 'iptables is required' >&2; exit 1; }
mode=${1:-apply}
case "$mode" in apply|--check|--remove) ;; *) echo 'Usage: egress-guard.sh [--check|--remove]' >&2; exit 2;; esac
[ "$#" -le 1 ] || exit 2
subnet=192.168.247.0/24
tag=online-shopping-egress-guard
destinations='169.254.169.254/32 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16'
rule() { iptables -w "$1" DOCKER-USER -s "$subnet" -d "$2" -m comment --comment "$tag" -j DROP; }
remove() {
    for destination in $destinations; do
        while rule -C "$destination" 2>/dev/null; do rule -D "$destination"; done
    done
}
# Require every owned DROP ahead of any pre-existing RETURN/ACCEPT, including
# established/related accepts. Public traffic continues through Docker policy.
check() {
    for destination in $destinations; do rule -C "$destination" 2>/dev/null || return 1; done
    rules=$(iptables -w -S DOCKER-USER)
    count=0
    while IFS= read -r line; do
        case "$line" in
            '-A DOCKER-USER '*)
                case "$count" in
                    0) expected=192.168.0.0/16;;
                    1) expected=172.16.0.0/12;;
                    2) expected=10.0.0.0/8;;
                    3) expected=169.254.169.254/32;;
                esac
                [ "$line" = "-A DOCKER-USER -s $subnet -d $expected -m comment --comment $tag -j DROP" ] || return 1
                count=$((count + 1))
                [ "$count" -lt 4 ] || return 0
                ;;
        esac
    done <<EOF
$rules
EOF
    return 1
}
case "$mode" in
    --remove) remove; echo 'Egress guard removed';;
    --check) check || { echo 'Egress guard missing or not first' >&2; exit 1; }; echo 'Egress guard ready';;
    apply)
        if ! check; then
            remove
            for destination in $destinations; do
                iptables -w -I DOCKER-USER 1 -s "$subnet" -d "$destination" -m comment --comment "$tag" -j DROP
            done
        fi
        check || { echo 'Egress guard verification failed' >&2; exit 1; }
        echo 'Egress guard ready'
        ;;
esac
