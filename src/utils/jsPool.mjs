Promise.runWithConcurrency = ({ taskFunc, params, maxThreads }) => {
    return new Promise((resolve) => {
        const results = new Array(params.length);
        let activeThreads = 0, index = 0, completed = 0;
        const next = () => {
            if (completed === params.length) {
                resolve(results);
                return;
            }
            while (activeThreads < maxThreads && index < params.length) {
                const currentIndex = index++;
                activeThreads++;

                Promise.resolve()
                    .then(() => taskFunc(params[currentIndex], currentIndex))
                    .then(result => results[currentIndex] = {
                        index: currentIndex,
                        type: "Success",
                        data: result,
                        message: undefined
                    })
                    .catch(err => results[currentIndex] = {
                        index: currentIndex,
                        type: "Fail",
                        data: err,
                        message: err.message
                    })
                    .finally(() => {
                        activeThreads--;
                        completed++;
                        next();
                    });
            }
        };
        next();
    });
}
