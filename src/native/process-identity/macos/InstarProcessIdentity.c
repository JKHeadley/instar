/* Bounded same-user process observations for the passive session monitor. */
#include <limits.h>
#include <libproc.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/proc.h>
#include <sys/proc_info.h>
#include <unistd.h>

#define MAX_PIDS 64

static bool parse_pid(const char *text, pid_t *pid) {
    if (*text < '1' || *text > '9') return false;
    int value = 0;
    for (const char *p = text; *p; p++) {
        if (*p < '0' || *p > '9') return false;
        int digit = *p - '0';
        if (value > (INT_MAX - digit) / 10) return false;
        value = value * 10 + digit;
    }
    *pid = (pid_t)value;
    return true;
}

static bool read_identity(pid_t pid, struct proc_bsdinfo *info) {
    const int size = (int)sizeof(*info);
    return proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, info, size) == size
        && info->pbi_pid == (unsigned)pid && info->pbi_uid == geteuid()
        && info->pbi_status != SZOMB && info->pbi_start_tvsec > 0
        && info->pbi_start_tvusec < 1000000;
}

/* JSON has a UTF-8 boundary. Do not let replacement characters become path evidence. */
static bool valid_utf8(const char *text) {
    const unsigned char *p = (const unsigned char *)text;
    while (*p) {
        uint32_t code = *p++;
        if (code < 0x80) continue;

        int continuation;
        uint32_t minimum;
        if (code >= 0xc2 && code <= 0xdf) {
            continuation = 1;
            minimum = 0x80;
            code &= 0x1f;
        } else if (code >= 0xe0 && code <= 0xef) {
            continuation = 2;
            minimum = 0x800;
            code &= 0x0f;
        } else if (code >= 0xf0 && code <= 0xf4) {
            continuation = 3;
            minimum = 0x10000;
            code &= 0x07;
        } else {
            return false;
        }
        for (int i = 0; i < continuation; i++, p++) {
            if ((*p & 0xc0) != 0x80) return false;
            code = (code << 6) | (*p & 0x3f);
        }
        if (code < minimum || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return false;
    }
    return true;
}

static bool sample(pid_t pid, struct proc_bsdinfo *identity, char path[PROC_PIDPATHINFO_MAXSIZE]) {
    struct proc_bsdinfo after;
    if (!read_identity(pid, identity)) return false;
    memset(path, 0, PROC_PIDPATHINFO_MAXSIZE);
    int length = proc_pidpath(pid, path, PROC_PIDPATHINFO_MAXSIZE);
    if (length <= 0 || length >= PROC_PIDPATHINFO_MAXSIZE || path[0] != '/'
        || !memchr(path, '\0', PROC_PIDPATHINFO_MAXSIZE) || !valid_utf8(path)) return false;
    if (!read_identity(pid, &after)) return false;
    return identity->pbi_start_tvsec == after.pbi_start_tvsec
        && identity->pbi_start_tvusec == after.pbi_start_tvusec
        && identity->pbi_ppid == after.pbi_ppid;
}

static void print_json_string(const char *text) {
    putchar('"');
    for (const unsigned char *p = (const unsigned char *)text; *p; p++) {
        if (*p == '"' || *p == '\\') {
            putchar('\\');
            putchar(*p);
        } else if (*p < 32) {
            printf("\\u%04x", (unsigned)*p);
        } else {
            putchar(*p);
        }
    }
    putchar('"');
}

int main(int argc, char **argv) {
    if (argc < 2 || argc - 1 > MAX_PIDS) return 64;
    pid_t pids[MAX_PIDS];
    for (int i = 1; i < argc; i++) {
        if (!parse_pid(argv[i], &pids[i - 1])) return 64;
        for (int j = 0; j < i - 1; j++) {
            if (pids[j] == pids[i - 1]) return 64;
        }
    }

    bool first = true;
    putchar('[');
    for (int i = 0; i < argc - 1; i++) {
        struct proc_bsdinfo identity;
        char path[PROC_PIDPATHINFO_MAXSIZE];
        if (!sample(pids[i], &identity, path)) continue;
        if (!first) putchar(',');
        first = false;
        printf("{\"pid\":%d,\"parentPid\":%u,\"kernelStartToken\":\"%llu.%06llu\",\"executable\":",
               pids[i], identity.pbi_ppid, (unsigned long long)identity.pbi_start_tvsec,
               (unsigned long long)identity.pbi_start_tvusec);
        print_json_string(path);
        putchar('}');
    }
    puts("]");
    return fflush(stdout) == 0 ? 0 : 74;
}
