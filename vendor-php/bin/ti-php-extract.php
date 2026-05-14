#!/usr/bin/env php
<?php
declare(strict_types=1);

require_once __DIR__ . '/../vendor/autoload.php';

use PhpParser\Error as ParserError;
use PhpParser\Node;
use PhpParser\NodeTraverser;
use PhpParser\NodeVisitorAbstract;
use PhpParser\ParserFactory;

final class Patterns
{
    /** @var array<int, array<string, mixed>> */
    public static array $entries = [];
}

final class Visitor extends NodeVisitorAbstract
{
    /** @var array<int, array<string, mixed>> */
    public array $facts = [];
    public string $file;
    public string $relFile;
    public ?string $namespace = null;
    /** @var array<string, string> */
    public array $useAliases = [];
    /** @var array<int, string> */
    public array $classStack = [];
    public bool $classIsPhpUnit = false;
    /** @var array<int, string> */
    public array $phpUnitBaseClasses = ['PHPUnit\\Framework\\TestCase'];

    /** @var array<string, true> Static PHP language built-ins. */
    private const PHP_BUILTIN_CLASSES = [
        // SPL exceptions + core hierarchy
        'Exception' => true, 'Error' => true, 'TypeError' => true,
        'ValueError' => true, 'ArgumentCountError' => true, 'ArithmeticError' => true,
        'AssertionError' => true, 'DivisionByZeroError' => true, 'ParseError' => true,
        'UnhandledMatchError' => true, 'Throwable' => true,
        'LogicException' => true, 'BadFunctionCallException' => true,
        'BadMethodCallException' => true, 'DomainException' => true,
        'InvalidArgumentException' => true, 'LengthException' => true,
        'OutOfRangeException' => true, 'RuntimeException' => true,
        'OutOfBoundsException' => true, 'OverflowException' => true,
        'RangeException' => true, 'UnderflowException' => true,
        'UnexpectedValueException' => true,
        // SPL data structures + iterators
        'ArrayAccess' => true, 'ArrayIterator' => true, 'ArrayObject' => true,
        'Countable' => true, 'IteratorAggregate' => true, 'Iterator' => true,
        'IteratorIterator' => true, 'Traversable' => true, 'Generator' => true,
        'SplDoublyLinkedList' => true, 'SplFixedArray' => true,
        'SplHeap' => true, 'SplMaxHeap' => true, 'SplMinHeap' => true,
        'SplObjectStorage' => true, 'SplPriorityQueue' => true,
        'SplQueue' => true, 'SplStack' => true, 'SplObserver' => true,
        'SplSubject' => true, 'SplFileInfo' => true, 'SplFileObject' => true,
        'SplTempFileObject' => true, 'WeakMap' => true, 'WeakReference' => true,
        'Stringable' => true, 'UnitEnum' => true, 'BackedEnum' => true,
        'Closure' => true, 'Generator' => true,
        // SPL filesystem / recursive iterators
        'DirectoryIterator' => true, 'FilesystemIterator' => true,
        'RecursiveDirectoryIterator' => true, 'GlobIterator' => true,
        'RecursiveIteratorIterator' => true, 'RecursiveArrayIterator' => true,
        'RecursiveFilterIterator' => true, 'RecursiveCallbackFilterIterator' => true,
        'RecursiveRegexIterator' => true, 'RecursiveTreeIterator' => true,
        'RegexIterator' => true, 'AppendIterator' => true,
        'CachingIterator' => true, 'CallbackFilterIterator' => true,
        'EmptyIterator' => true, 'FilterIterator' => true,
        'InfiniteIterator' => true, 'LimitIterator' => true,
        'MultipleIterator' => true, 'NoRewindIterator' => true,
        'ParentIterator' => true, 'OuterIterator' => true,
        'RecursiveCachingIterator' => true, 'SeekableIterator' => true,
        // Reflection
        'Reflection' => true, 'ReflectionClass' => true,
        'ReflectionClassConstant' => true, 'ReflectionEnum' => true,
        'ReflectionEnumBackedCase' => true, 'ReflectionEnumUnitCase' => true,
        'ReflectionExtension' => true, 'ReflectionFiber' => true,
        'ReflectionFunction' => true, 'ReflectionFunctionAbstract' => true,
        'ReflectionGenerator' => true, 'ReflectionMethod' => true,
        'ReflectionNamedType' => true, 'ReflectionObject' => true,
        'ReflectionParameter' => true, 'ReflectionProperty' => true,
        'ReflectionReference' => true, 'ReflectionType' => true,
        'ReflectionUnionType' => true, 'ReflectionIntersectionType' => true,
        'ReflectionZendExtension' => true, 'Reflector' => true,
        // Date/Time
        'DateTime' => true, 'DateTimeImmutable' => true,
        'DateTimeInterface' => true, 'DateTimeZone' => true,
        'DateInterval' => true, 'DatePeriod' => true,
        // Common standard / extensions
        'stdClass' => true, 'Imagick' => true, 'ImagickDraw' => true,
        'ImagickPixel' => true, 'ImagickPixelIterator' => true,
        'ImagickKernel' => true, 'PDO' => true, 'PDOStatement' => true,
        'PDOException' => true, 'mysqli' => true, 'mysqli_stmt' => true,
        'mysqli_result' => true, 'SQLite3' => true, 'SQLite3Stmt' => true,
        'SQLite3Result' => true, 'XMLReader' => true, 'XMLWriter' => true,
        'DOMDocument' => true, 'DOMNode' => true, 'DOMElement' => true,
        'DOMNodeList' => true, 'DOMXPath' => true, 'DOMAttr' => true,
        'DOMText' => true, 'DOMComment' => true, 'DOMException' => true,
        'SimpleXMLElement' => true, 'JsonException' => true,
        'JsonSerializable' => true, 'CURLFile' => true, 'CURLStringFile' => true,
        'Fiber' => true, 'FiberError' => true,
        // Common PHP extensions (Imagick/Memcached/Zip etc.)
        'Memcached' => true, 'Memcache' => true,
        'Redis' => true, 'RedisException' => true,
        'ZipArchive' => true, 'Phar' => true, 'PharData' => true,
        'PharException' => true, 'PharFileInfo' => true,
        'finfo' => true, 'GMP' => true, 'GdImage' => true,
    ];

    /** @var array<string, true>|null lowercase mirror, lazily built once */
    private static ?array $phpBuiltinClassesLower = null;

    private static function isPhpBuiltinClass(string $name): bool
    {
        if (self::$phpBuiltinClassesLower === null) {
            self::$phpBuiltinClassesLower = [];
            foreach (self::PHP_BUILTIN_CLASSES as $k => $_) {
                self::$phpBuiltinClassesLower[strtolower($k)] = true;
            }
        }
        return isset(self::$phpBuiltinClassesLower[strtolower($name)]);
    }

    public function __construct(string $file, ?string $relFile = null)
    {
        $this->file = $file;
        // Project-relative POSIX path used in test_ids + anchor keys so
        // outputs are portable across machines. When omitted, the absolute
        // path is the fallback identifier.
        $this->relFile = $relFile ?? $file;
    }

    public function enterNode(Node $node): void
    {
        if ($node instanceof Node\Stmt\Namespace_) {
            $this->namespace = $node->name?->toString();
            $this->useAliases = [];
            return;
        }
        if ($node instanceof Node\Stmt\Use_) {
            foreach ($node->uses as $u) {
                $alias = $u->alias?->name ?? $u->name->getLast();
                $this->useAliases[$alias] = $u->name->toString();
            }
            return;
        }
        if ($node instanceof Node\Stmt\ClassLike && $node->name !== null) {
            $name = $this->namespace ? $this->namespace . '\\' . $node->name->name : $node->name->name;
            $this->classStack[] = $name;
            $isPhpUnit = false;
            if ($node instanceof Node\Stmt\Class_ && $node->extends !== null) {
                $this->emitClassUse($node, $node->extends);
                $extends = $this->resolveClassName($node->extends);
                if (in_array($extends, $this->phpUnitBaseClasses, true)) {
                    $isPhpUnit = true;
                } elseif ($this->looksLikeTestBaseClass($extends)) {
                    // Catch transitive base classes by name pattern. WP tests
                    // extend WP_UnitTestCase, WC tests extend WC_Unit_Test_Case,
                    // many projects roll their own ProjectTestCase. The static
                    // extractor can't follow the inheritance chain across files
                    // in a single pass, so use the parent's name as the signal.
                    $isPhpUnit = true;
                }
            }
            if ($node instanceof Node\Stmt\Class_) {
                foreach ($node->implements as $iface) {
                    $this->emitClassUse($node, $iface);
                }
            }
            if ($node instanceof Node\Stmt\Interface_) {
                foreach ($node->extends as $parent) {
                    $this->emitClassUse($node, $parent);
                }
            }
            $this->classIsPhpUnit = $isPhpUnit;
            $this->facts[] = $this->factSymbolDef($node, $name, true);
            return;
        }
        if ($node instanceof Node\Stmt\Function_) {
            $name = $this->namespace ? $this->namespace . '\\' . $node->name->name : $node->name->name;
            $this->facts[] = $this->factSymbolDef($node, $name, true);
            return;
        }
        if ($node instanceof Node\Stmt\ClassMethod && !empty($this->classStack)) {
            $class = end($this->classStack);
            $fqn = $class . '::' . $node->name->name;
            $this->facts[] = $this->factSymbolDef($node, $fqn, false);
            if ($this->classIsPhpUnit && $this->isPhpUnitTestMethod($node)) {
                $this->facts[] = $this->factTestDef($node, $class, $node->name->name);
            }
            return;
        }
        if ($node instanceof Node\Expr\FuncCall) {
            $this->tryEmitDeclarative('function-call', $node, $this->funcName($node), null);
            return;
        }
        if ($node instanceof Node\Expr\MethodCall) {
            $name = $node->name instanceof Node\Identifier ? $node->name->name : null;
            $recv = $node->var instanceof Node\Expr\Variable && is_string($node->var->name) ? $node->var->name : null;
            if ($name !== null) $this->tryEmitDeclarative('method-call', $node, $name, $recv);
            return;
        }
        if ($node instanceof Node\Expr\StaticCall) {
            $name = $node->name instanceof Node\Identifier ? $node->name->name : null;
            if ($node->class instanceof Node\Name) {
                $this->emitClassUse($node, $node->class);
                $recv = $this->resolveClassName($node->class);
            } else {
                $recv = null;
            }
            if ($name !== null) $this->tryEmitDeclarative('static-call', $node, $name, $recv);
            return;
        }
        if ($node instanceof Node\Expr\New_) {
            if ($node->class instanceof Node\Name) {
                $this->emitClassUse($node, $node->class);
            }
            return;
        }
        if ($node instanceof Node\Expr\ClassConstFetch) {
            if ($node->class instanceof Node\Name) {
                $this->emitClassUse($node, $node->class);
            }
            return;
        }
        if ($node instanceof Node\Expr\StaticPropertyFetch) {
            if ($node->class instanceof Node\Name) {
                $this->emitClassUse($node, $node->class);
            }
            return;
        }
    }

    public function leaveNode(Node $node): void
    {
        if ($node instanceof Node\Stmt\Namespace_) $this->namespace = null;
        if ($node instanceof Node\Stmt\ClassLike) {
            array_pop($this->classStack);
            $this->classIsPhpUnit = false;
        }
    }

    private function isPhpUnitTestMethod(Node\Stmt\ClassMethod $m): bool
    {
        $name = $m->name->name;
        if (str_starts_with($name, 'test')) return true;
        $doc = $m->getDocComment()?->getText() ?? '';
        if (str_contains($doc, '@test')) return true;
        foreach ($m->attrGroups as $g) {
            foreach ($g->attrs as $a) {
                if ($a->name->toString() === 'Test') return true;
            }
        }
        return false;
    }

    private function funcName(Node\Expr\FuncCall $n): ?string
    {
        if ($n->name instanceof Node\Name) return $n->name->toString();
        return null;
    }

    // Heuristic: a parent class name that ends in TestCase / UnitTestCase /
    // Test_Case (any casing) is almost certainly a test base class. The chain
    // up to PHPUnit\Framework\TestCase can be 4+ hops (WP: WP_UnitTestCase →
    // WP_UnitTestCase_Base → PHPUnit_Adapter_TestCase → Polyfill_TestCase →
    // TestCase), which a per-file extractor cannot resolve.
    private function looksLikeTestBaseClass(string $fqn): bool
    {
        $last = $fqn;
        $pos = strrpos($fqn, '\\');
        if ($pos !== false) $last = substr($fqn, $pos + 1);
        return (bool)preg_match('/(?:^|_)(?:Unit)?Test_?Case$/i', $last);
    }

    private function resolveName(string $raw): string
    {
        $raw = ltrim($raw, '\\');
        if (isset($this->useAliases[$raw])) return $this->useAliases[$raw];
        $first = strstr($raw, '\\', true);
        if ($first === false) $first = $raw;
        if (isset($this->useAliases[$first])) {
            return $this->useAliases[$first] . substr($raw, strlen($first));
        }
        return $raw;
    }

    // Like resolveName, but applies PHP scope rules for class references:
    // fully-qualified names lose only their leading backslash; unqualified
    // names without a matching use-alias receive the current namespace as
    // prefix. Used for class instantiation / extends / implements / static
    // access, where this scoping is semantically required.
    private function resolveClassName(Node\Name $name): string
    {
        $raw = $name->toString();
        if ($name->isFullyQualified()) {
            return ltrim($raw, '\\');
        }
        $first = strstr($raw, '\\', true);
        if ($first === false) $first = $raw;
        if (isset($this->useAliases[$first])) {
            return $this->useAliases[$first] . substr($raw, strlen($first));
        }
        if ($this->namespace !== null) {
            return $this->namespace . '\\' . $raw;
        }
        return $raw;
    }

    private function emitClassUse(Node $where, ?Node\Name $cls): void
    {
        if ($cls === null) return;
        // self / static / parent are pseudo-classes referring to the current
        // class lexically — not real symbols. Emitting them as anchors
        // produces giant useless pairings (every `self::foo()` would point
        // at every other class anywhere using `self`).
        $raw = $cls->toString();
        if (!$cls->isFullyQualified()) {
            $lower = strtolower($raw);
            if ($lower === 'self' || $lower === 'static' || $lower === 'parent') return;
        }
        $resolved = $this->resolveClassName($cls);
        // PHP language built-ins (Exception, stdClass, DateTime, Reflection*,
        // etc.) have no project symbol-def, so emitting uses just produces
        // dead anchors. Skip them entirely. Mirror of the Node-builtin handling
        // on the TS side. PHP class names are case-insensitive — match on
        // lowercase so `imagick` and `Imagick` both hit.
        if (self::isPhpBuiltinClass($resolved)) return;
        $this->facts[] = [
            'kind' => 'symbol-use',
            'resolved' => true,
            'location' => $this->loc($where),
            'anchors' => [['key' => 'php-symbol:' . $resolved, 'role' => 'subject']],
            'payload' => ['kind' => 'symbol-use', 'name' => $resolved],
        ];
    }

    /** @return array<string, mixed> */
    private function factSymbolDef(Node $n, string $name, bool $exported): array
    {
        // role: 'target' — definitions are the destination of references.
        // symbol-use facts at role 'subject' bridge here via the anchor index.
        return [
            'kind' => 'symbol-def',
            'resolved' => true,
            'location' => $this->loc($n),
            'anchors' => [['key' => 'php-symbol:' . $name, 'role' => 'target']],
            'payload' => ['kind' => 'symbol-def', 'name' => $name, 'exported' => $exported],
        ];
    }

    /** @return array<string, mixed> */
    private function factTestDef(Node $n, string $class, string $method): array
    {
        $id = 'phpunit:' . $this->relFile . '::' . $class . '::' . $method;
        return [
            'kind' => 'test-def',
            'resolved' => true,
            'location' => $this->loc($n),
            'anchors' => [['key' => 'test:' . $id, 'role' => 'subject']],
            'payload' => ['kind' => 'test-def', 'framework' => 'phpunit', 'testId' => $id, 'title' => $class . '::' . $method],
        ];
    }

    /** @return array<string, mixed> */
    private function loc(Node $n): array
    {
        return [
            'file' => $this->file,
            'startLine' => $n->getStartLine() ?: 1,
            'endLine' => $n->getEndLine() ?: 1,
        ];
    }

    private function tryEmitDeclarative(string $nodeKind, Node $n, ?string $name, ?string $receiver): void
    {
        if ($name === null) return;
        foreach (Patterns::$entries as $p) {
            $m = $p['match'] ?? null;
            if (!is_array($m)) continue;
            if (($m['lang'] ?? null) !== 'php') continue;
            if (($m['nodeKind'] ?? null) !== $nodeKind) continue;
            if (($m['name'] ?? null) !== $name) continue;
            if (isset($m['receiver']) && $m['receiver'] !== $receiver) continue;

            $args = $this->extractArgs($n);
            $payload = ['kind' => $p['emit']];
            $resolved = true;
            foreach (($p['bind'] ?? []) as $field => $b) {
                $i = $b['arg'];
                $v = $this->readLiteral($args[$i] ?? null, $b['type']);
                if ($v === null && !($b['optional'] ?? false)) $resolved = false;
                if ($v !== null) {
                    $payload[$field] = $v;
                    if (is_string($v) && str_contains($v, '{*}')) $resolved = false;
                }
            }
            $anchors = [];
            $anchorRule = $p['anchor'] ?? null;
            if (is_array($anchorRule)) {
                $key = $this->renderAnchorKey($anchorRule['template'] ?? '', $payload);
                if ($key !== null) $anchors[] = ['key' => $key, 'role' => $anchorRule['role'] ?? 'subject'];
                else $resolved = false;
            }
            $this->facts[] = [
                'kind' => $p['emit'],
                'resolved' => $resolved,
                'location' => $this->loc($n),
                'anchors' => $anchors,
                'payload' => $payload,
            ];
        }
    }

    /** @return array<int, Node> */
    private function extractArgs(Node $n): array
    {
        if ($n instanceof Node\Expr\FuncCall || $n instanceof Node\Expr\MethodCall || $n instanceof Node\Expr\StaticCall) {
            $out = [];
            foreach ($n->args as $a) {
                if ($a instanceof Node\Arg) $out[] = $a->value;
            }
            return $out;
        }
        return [];
    }

    private function readStringSkeleton(?Node $node): ?string
    {
        if ($node === null) return null;
        if ($node instanceof Node\Scalar\String_) return $node->value;
        if ($node instanceof Node\Expr\BinaryOp\Concat) {
            $left  = $this->readStringSkeleton($node->left);
            $right = $this->readStringSkeleton($node->right);
            if ($left === null && $right === null) return '{*}';
            return ($left ?? '{*}') . ($right ?? '{*}');
        }
        return null;
    }

    private function readLiteral(?Node $node, string $type): mixed
    {
        if ($node === null) return null;
        if ($type === 'string') return $this->readStringSkeleton($node);
        if ($type === 'int' && $node instanceof Node\Scalar\Int_) return $node->value;
        if ($type === 'bool') {
            if ($node instanceof Node\Expr\ConstFetch) {
                $n = strtolower($node->name->toString());
                if ($n === 'true' || $n === 'false') return $n === 'true';
            }
            return null;
        }
        if ($type === 'callable') {
            if ($node instanceof Node\Scalar\String_) return $node->value;
            if ($node instanceof Node\Expr\Array_ && count($node->items) === 2) {
                $aItem = $node->items[0];
                $bItem = $node->items[1];
                if ($aItem === null || $bItem === null) return null;
                $a = $aItem->value;
                $b = $bItem->value;
                $aStr = $a instanceof Node\Scalar\String_ ? $a->value : null;
                $bStr = $b instanceof Node\Scalar\String_ ? $b->value : null;
                if ($aStr !== null && $bStr !== null) return $aStr . '::' . $bStr;
            }
            return null;
        }
        if ($type === 'path-literal' && $node instanceof Node\Scalar\String_) return $node->value;
        return null;
    }

    /** @param array<string, mixed> $payload */
    private function renderAnchorKey(string $tpl, array $payload): ?string
    {
        $ok = true;
        $out = preg_replace_callback('/\{(\w+)\}/', function (array $m) use ($payload, &$ok): string {
            if (!isset($payload[$m[1]])) { $ok = false; return ''; }
            return (string) $payload[$m[1]];
        }, $tpl);
        return $ok ? $out : null;
    }
}

$parser = (new ParserFactory)->createForNewestSupportedVersion();

$stdin = fopen('php://stdin', 'r');
while (($line = fgets($stdin)) !== false) {
    $line = trim($line);
    if ($line === '') continue;
    $req = json_decode($line, true);
    if (!is_array($req)) {
        emit(['op' => 'error', 'message' => 'invalid JSON']);
        continue;
    }
    $op = $req['op'] ?? '';
    if ($op === 'ping') { emit(['op' => 'pong']); continue; }
    if ($op === 'shutdown') exit(0);
    if ($op === 'register-patterns') {
        Patterns::$entries = $req['patterns'] ?? [];
        emit(['op' => 'registered', 'count' => count(Patterns::$entries)]);
        continue;
    }
    if ($op === 'extract') {
        $file = $req['file'] ?? '';
        $relFile = isset($req['relFile']) && is_string($req['relFile']) ? $req['relFile'] : null;
        if (!is_string($file) || !is_file($file)) {
            emit(['op' => 'facts', 'file' => $file, 'facts' => []]);
            continue;
        }
        try {
            $code = file_get_contents($file);
            if ($code === false) { emit(['op' => 'facts', 'file' => $file, 'facts' => []]); continue; }
            $ast = $parser->parse($code);
            if ($ast === null) { emit(['op' => 'facts', 'file' => $file, 'facts' => []]); continue; }
            $visitor = new Visitor($file, $relFile);
            $visitor->phpUnitBaseClasses = $req['phpUnitBaseClasses'] ?? ['PHPUnit\\Framework\\TestCase'];
            $traverser = new NodeTraverser();
            $traverser->addVisitor($visitor);
            $traverser->traverse($ast);
            emit(['op' => 'facts', 'file' => $file, 'facts' => $visitor->facts]);
        } catch (ParserError $e) {
            emit([
                'op' => 'facts',
                'file' => $file,
                'facts' => [[
                    'kind' => 'parse-error',
                    'resolved' => false,
                    'location' => ['file' => $file, 'startLine' => $e->getStartLine() ?: 1, 'endLine' => $e->getStartLine() ?: 1],
                    'anchors' => [],
                    'payload' => ['kind' => 'parse-error', 'message' => $e->getMessage(), 'line' => $e->getStartLine() ?: 1],
                ]],
            ]);
        } catch (\Throwable $t) {
            emit(['op' => 'error', 'message' => 'extract failed: ' . $t->getMessage()]);
        }
        continue;
    }
    emit(['op' => 'error', 'message' => 'unknown op: ' . $op]);
}

/** @param array<string, mixed> $msg */
function emit(array $msg): void
{
    fwrite(STDOUT, json_encode($msg, JSON_UNESCAPED_SLASHES) . "\n");
    fflush(STDOUT);
}
