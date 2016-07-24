var Promise = require("bluebird")
var fs = require("fs");

/* Add standard fs functions */
var functions = [
    "readFile"
]

functions.forEach(promisifyFunction)

function promisifyFunction(name) {
    module.exports[name] = Promise.promisify(fs[name])
}