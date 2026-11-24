#include <errno.h>
#include <limits.h>
#include <stdlib.h>
#include <sys/socket.h>
#include <sys/un.h>

int main(int argc, char **argv) {
    if (argc != 2) return 2;
    char *end = NULL;
    errno = 0;
    long expected = strtol(argv[1], &end, 10);
    if (errno != 0 || end == argv[1] || *end != '\0' || expected <= 0 || expected > INT_MAX) return 2;
    pid_t observed = 0;
    socklen_t size = sizeof(observed);
    if (getsockopt(3, SOL_LOCAL, LOCAL_PEERPID, &observed, &size) != 0 || size != sizeof(observed)) return 2;
    return observed == expected ? 0 : 1;
}
