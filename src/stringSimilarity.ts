export function levenshteinDistance(left: string, right: string): number {
    if (left === right) {
        return 0;
    }
    if (!left) {
        return right.length;
    }
    if (!right) {
        return left.length;
    }

    const rowText = left.length >= right.length ? left : right;
    const columnText = left.length >= right.length ? right : left;
    let previous = new Uint32Array(columnText.length + 1);
    let current = new Uint32Array(columnText.length + 1);

    for (let column = 0; column <= columnText.length; column += 1) {
        previous[column] = column;
    }

    for (let row = 1; row <= rowText.length; row += 1) {
        current[0] = row;
        for (let column = 1; column <= columnText.length; column += 1) {
            const substitutionCost = rowText[row - 1] === columnText[column - 1] ? 0 : 1;
            current[column] = Math.min(
                previous[column] + 1,
                current[column - 1] + 1,
                previous[column - 1] + substitutionCost
            );
        }
        [previous, current] = [current, previous];
    }

    return previous[columnText.length];
}

export function calculateLevenshteinSimilarity(left: string, right: string): number {
    if (!left || !right) {
        return 0;
    }
    if (left === right) {
        return 1;
    }

    const maxLength = Math.max(left.length, right.length);
    return 1 - levenshteinDistance(left, right) / maxLength;
}
