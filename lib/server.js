module.exports = {
    run: run
}

var http = require("http")
var path = require("path")
var queryString = require("querystring")
var url = require("url")
var _ = require("underscore")
var _pumlhorse = require("pumlhorse")
var fs = require("./promiseFs")

var _sitePath;
var _server;
var _staticRoutes = {}
var _dynamicRoutes = {}

function run(siteDirectory) {
    _sitePath = siteDirectory
    settings = require(path.join(_sitePath, "site.json"))
    initRoutes(settings.routes)
    
    _server = new http.Server()
    _server.listen(34143, () => console.log("Running on port %s", _server.address().port))
    _server.on("request", handleRequest)
}

var routeParameter = /<(\w+)>/gi
function initRoutes(routes) {
    if (routes == null) throw new Error("site.json must contain 'routes' dictionary")

    for (var method in routes) {
        method = method.toLowerCase()
        _staticRoutes[method] = {}
        _dynamicRoutes[method] = []
        for (var route in routes[method]) {
            var routeVariables = route.match(routeParameter)
            if (routeVariables == null) {
                _staticRoutes[method][route] = new Handler(routes[method][route])
            }
            else {
                var routePattern = new RegExp(route.replace(routeParameter, "(.+)"))
                _dynamicRoutes[method].push(new DynamicRoute(route,
                    routePattern,
                    routeVariables.map((variable) => variable.replace(routeParameter, "$1")),
                    new Handler(routes[method][route])
                ))
            }
        }
    }
}

function DynamicRoute(route, pattern, variables, handler) {
    this.route = route
    this.pattern = pattern
    this.variables = variables
    this.handler = handler
}

function handleRequest(rawRequest, response) {
    var request = new Request(rawRequest)
    var handler = getHandler(request)

    if (handler == null) {
        notFound(response)
        return;
    }

    rawRequest.on("end", () => {
        runRequest(request, handler, response)
    })
    
}

function getHandler(request) {
    var handlers = _staticRoutes[request.method]
    if (handlers != null && handlers[request.path] != null) return handlers[request.path];

    var routes = _dynamicRoutes[request.method]
    if (routes == null) return null

    for (var i in routes) {
        var routeInfo = routes[i]
        var routeParameters = request.path.match(routeInfo.pattern)
        if (routeParameters == null) continue;

        for (var i = 1; i < routeParameters.length; i++) {
            request.addRouteParameter(routeInfo.variables[i - 1], routeParameters[i])
        }
        return routeInfo.handler
    }
}

function Request(request) {
    this.request = request
    this.rawUrl = request.url
    this.url = url.parse(request.url)
    this.path = this.url.pathname
    this.method = request.method.toLowerCase()
    this.headers = request.headers
    this.routeParameters = {}
    this.rawBody = ""

    var self = this
    request.on("data", (chunk) => self.rawBody += chunk)
}
Request.prototype.addRouteParameter = function (name, value) {
    this.routeParameters[name] = decodeURI(value)
}
Request.prototype.toContext = function () {
    return {
        path: this.routeParameters,
        query: queryString.parse(this.url.query),
        headers: this.headers,
        body: getBody(this.rawBody, this.headers["content-type"])
    }
}

function getBody(bodyText, contentType) {
    var parser = parsers[contentType]
    if (parser != null && bodyText != null && bodyText.length > 0) {
        return parser(bodyText)
    }

    return bodyText
}

var parsers = {
    "application/json": JSON.parse,
    "text/json": JSON.parse
}

function Handler(settings) {
    if (_.isString(settings)) {
        this.file = settings
    }
    else if (_.isObject(settings)) {
        this.file = settings.script
        this.filters = settings.filters
    }
    else throw new Error("Unexpected script format")
}


function runRequest(request, handler, response) {

    var context = request.toContext()

    createModule(response)
    
    _pumlhorse.runProfile({
        include: [path.join(_sitePath, handler.file)],
        modules: [
            {
                name: "pumlhorse-webserver",
                path: path.join(__dirname, "noop")
            }
        ],
        contexts: [context]
    }, {
        onScriptFinished: (scriptId, err) => { if (err) serverError(response, err.toString()) }
    })
        .catch((err) => {
            serverError(response, err.toString())
        })

    // getPumlScript(request, handler)
    //     .then((script) => {
    //         script.addModule("pumlhorse-webserver")
    //         return script.run(context)
    //     })
    //     .catch((err) => {
    //         serverError(response, err.toString())
    //     })
    
}

function getPumlScript(request, handler) {
    return fs.readFile(path.join(_sitePath, handler.file), "utf-8")
        .then((data) => {
            return _pumlhorse.load(data)
        })
}

function createModule(response) {
    pumlhorse.module("pumlhorse-webserver")
        .function("bad request", ["@", doResponse(response, badRequest)], { passAsObject: true})
        .function("not found", ["@", doResponse(response, notFound)], { passAsObject: true})
        .function("ok",  ["@", doResponse(response, ok)], { passAsObject: true})
    
}

function doResponse(response, func) {
    return function(body) {
        func(response, body)
    }
}

function ok(response, body) {
    end(response, 200, body)
}

function badRequest(response, body) {
    end(response, 400, body)
}

function notFound(response, body) {
    end(response, 404, body)
}

function serverError(response, body) {
    end(response, 500, body)
}

function end(response, code, body) {
    response.statusCode = code
    if (_.isObject(body)) {
        body = JSON.stringify(body)
        response.setHeader("Content-Type", "application/json")
    }
    response.end(body, "utf-8")
    throw new Error("Script ended")
}