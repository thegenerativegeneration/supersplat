// counts of progressStart and progressEnd
const progressCounts = (events) => {
    const counts = { start: 0, end: 0 };
    events.on('progressStart', () => counts.start++);
    events.on('progressEnd', () => counts.end++);
    return counts;
};

export { progressCounts };
