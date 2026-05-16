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
    /** @var array<string, string> */
    private array $defines = [];
    /** @var array<string, array<string, string>> */
    private array $classConsts = [];
    /** @var array<string, array<string, string>> */
    private array $classProps = [];
    /** @var list<string> Property names hit as $this->prop misses during the current arg-binding cycle. */
    private array $unresolvedThisProps = [];

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

    /** @var array<string, true> Common PHP stdlib + WP-core functions with no
     *  project symbol-def. A symbol-use for these is always a dead-end anchor,
     *  so it is skipped. Pragmatic, not exhaustive. */
    private const PHP_BUILTIN_FUNCTIONS = [
        // type checks
        'is_array' => true, 'is_string' => true, 'is_int' => true, 'is_integer' => true,
        'is_bool' => true, 'is_float' => true, 'is_numeric' => true, 'is_null' => true,
        'is_object' => true, 'is_callable' => true, 'is_scalar' => true, 'is_iterable' => true,
        'is_a' => true, 'gettype' => true, 'settype' => true, 'intval' => true,
        'strval' => true, 'floatval' => true, 'boolval' => true,
        // arrays
        'array_map' => true, 'array_filter' => true, 'array_merge' => true,
        'array_keys' => true, 'array_values' => true, 'array_key_exists' => true,
        'array_search' => true, 'array_slice' => true, 'array_splice' => true,
        'array_push' => true, 'array_pop' => true, 'array_shift' => true,
        'array_unshift' => true, 'array_reverse' => true, 'array_unique' => true,
        'array_flip' => true, 'array_combine' => true, 'array_fill' => true,
        'array_diff' => true, 'array_intersect' => true, 'array_column' => true,
        'array_reduce' => true, 'array_walk' => true, 'array_sum' => true,
        'array_product' => true, 'array_chunk' => true, 'array_pad' => true,
        'array_key_first' => true, 'array_key_last' => true, 'in_array' => true,
        'array_fill_keys' => true, 'array_diff_key' => true, 'array_intersect_key' => true,
        'count' => true, 'sizeof' => true, 'sort' => true, 'rsort' => true,
        'usort' => true, 'uasort' => true, 'uksort' => true, 'asort' => true,
        'ksort' => true, 'arsort' => true, 'krsort' => true, 'range' => true,
        'compact' => true, 'extract' => true,
        // strings
        'strlen' => true, 'strpos' => true, 'stripos' => true, 'strrpos' => true,
        'str_contains' => true, 'str_starts_with' => true, 'str_ends_with' => true,
        'str_replace' => true, 'str_ireplace' => true, 'substr' => true,
        'substr_count' => true, 'str_repeat' => true, 'str_pad' => true,
        'str_split' => true, 'str_word_count' => true, 'strtolower' => true,
        'strtoupper' => true, 'ucfirst' => true, 'lcfirst' => true, 'ucwords' => true,
        'trim' => true, 'ltrim' => true, 'rtrim' => true, 'explode' => true,
        'implode' => true, 'join' => true, 'sprintf' => true, 'printf' => true,
        'vsprintf' => true, 'number_format' => true, 'nl2br' => true,
        'htmlspecialchars' => true, 'htmlentities' => true, 'html_entity_decode' => true,
        'strip_tags' => true, 'addslashes' => true, 'stripslashes' => true,
        'wordwrap' => true, 'strrev' => true, 'strtr' => true, 'substr_replace' => true,
        'preg_match' => true, 'preg_match_all' => true, 'preg_replace' => true,
        'preg_replace_callback' => true, 'preg_split' => true, 'preg_quote' => true,
        'mb_strlen' => true, 'mb_substr' => true, 'mb_strtolower' => true,
        'mb_strtoupper' => true, 'mb_strpos' => true,
        // json / serialization
        'json_encode' => true, 'json_decode' => true, 'serialize' => true,
        'unserialize' => true, 'base64_encode' => true, 'base64_decode' => true,
        'maybe_serialize' => true, 'maybe_unserialize' => true,
        // math
        'abs' => true, 'ceil' => true, 'floor' => true, 'round' => true,
        'min' => true, 'max' => true, 'intdiv' => true, 'pow' => true,
        'sqrt' => true, 'rand' => true, 'mt_rand' => true, 'random_int' => true,
        // misc php
        'function_exists' => true, 'class_exists' => true,
        'method_exists' => true, 'property_exists' => true, 'defined' => true,
        'define' => true, 'constant' => true, 'func_get_args' => true,
        'func_num_args' => true, 'call_user_func' => true, 'call_user_func_array' => true,
        'var_dump' => true, 'print_r' => true, 'var_export' => true,
        'error_log' => true, 'trigger_error' => true,
        'date' => true, 'time' => true, 'strtotime' => true,
        'microtime' => true, 'mktime' => true, 'dirname' => true, 'basename' => true,
        'pathinfo' => true, 'realpath' => true, 'file_exists' => true,
        'file_get_contents' => true, 'file_put_contents' => true,
        // WP core — i18n + escaping
        '__' => true, '_e' => true, '_x' => true, '_n' => true, '_nx' => true,
        'esc_html' => true, 'esc_html__' => true, 'esc_html_e' => true,
        'esc_attr' => true, 'esc_attr__' => true, 'esc_attr_e' => true,
        'esc_url' => true, 'esc_url_raw' => true, 'esc_textarea' => true,
        'esc_js' => true, 'wp_kses' => true, 'wp_kses_post' => true,
        // WP core — sanitization
        'sanitize_text_field' => true, 'sanitize_title' => true,
        'sanitize_key' => true, 'sanitize_email' => true, 'sanitize_html_class' => true,
        'sanitize_file_name' => true, 'absint' => true,
        'wp_unslash' => true, 'wp_slash' => true, 'stripslashes_deep' => true,
        // WP core — options / meta
        'get_option' => true, 'update_option' => true, 'add_option' => true,
        'delete_option' => true, 'get_post_meta' => true, 'update_post_meta' => true,
        'get_transient' => true, 'set_transient' => true, 'delete_transient' => true,
        // WP core — misc. Hook functions (add_action/do_action/apply_filters/
        // …) are deliberately NOT denylisted: they are declarative-handled and
        // a separate test asserts they still emit a symbol-use.
        'wp_die' => true, 'wp_parse_args' => true,
        'add_query_arg' => true, 'remove_query_arg' => true, 'wp_redirect' => true,
        'current_user_can' => true, 'is_admin' => true, 'is_user_logged_in' => true,
        'wp_create_nonce' => true, 'wp_verify_nonce' => true, 'check_admin_referer' => true,
        'get_permalink' => true, 'home_url' => true, 'site_url' => true,
        'admin_url' => true, 'plugins_url' => true, 'wp_enqueue_script' => true,
        'wp_enqueue_style' => true, 'register_post_type' => true,
        'get_post' => true, 'get_posts' => true, 'wp_insert_post' => true,
    ];

    /** @var array<string, true>|null lowercase mirror, lazily built once */
    private static ?array $phpBuiltinFunctionsLower = null;

    private static function isBuiltinFunction(string $name): bool
    {
        if (self::$phpBuiltinFunctionsLower === null) {
            self::$phpBuiltinFunctionsLower = [];
            foreach (self::PHP_BUILTIN_FUNCTIONS as $k => $_) {
                self::$phpBuiltinFunctionsLower[strtolower($k)] = true;
            }
        }
        $bare = ltrim($name, '\\');
        $pos = strrpos($bare, '\\');
        if ($pos !== false) $bare = substr($bare, $pos + 1);
        return isset(self::$phpBuiltinFunctionsLower[strtolower($bare)]);
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
                $this->emitClassUse($node, $node->extends, 'extends');
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
            $def = $this->factSymbolDef($node, $name, true);
            $props = $this->classProps[$name] ?? [];
            if ($props !== []) {
                $def['payload']['meta'] = ['props' => $props];
            }
            $this->facts[] = $def;
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
        if ($node instanceof Node\Expr\Include_) {
            $raw = $this->readStringSkeleton($node->expr);
            if ($raw === null) {
                // Argument shape we don't know how to read — emit unresolved with no anchor.
                $this->facts[] = [
                    'kind' => 'php-include',
                    'resolved' => false,
                    'location' => $this->loc($node),
                    'anchors' => [],
                    'payload' => ['kind' => 'php-include', 'target' => '{*}'],
                ];
                return;
            }
            $hasWildcard = str_contains($raw, '{*}');
            $target = $hasWildcard ? $raw : $this->normalizeIncludePath($raw);
            $resolved = !$hasWildcard;
            $this->facts[] = [
                'kind' => 'php-include',
                'resolved' => $resolved,
                'location' => $this->loc($node),
                'anchors' => [['key' => 'php-file:' . $target, 'role' => 'target']],
                'payload' => ['kind' => 'php-include', 'target' => $target],
            ];
            return;
        }
        if ($node instanceof Node\Expr\FuncCall) {
            $name = $this->funcName($node);
            $this->tryEmitDeclarative('function-call', $node, $name, null);
            if ($name !== null && !self::isBuiltinFunction($name)) {
                $resolved = $this->resolveName($name);
                $this->facts[] = [
                    'kind' => 'symbol-use',
                    'resolved' => true,
                    'location' => $this->loc($node),
                    'anchors' => [['key' => 'php-symbol:' . $resolved, 'role' => 'target']],
                    'payload' => ['kind' => 'symbol-use', 'name' => $resolved],
                ];
            }
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

    private function emitClassUse(Node $where, ?Node\Name $cls, ?string $rel = null): void
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
        // $rel tags the kind of class reference. Only `extends` is tagged, so
        // the cross-file resolver can isolate inheritance edges from the
        // implements / new / static-call uses that also flow through here.
        $payload = ['kind' => 'symbol-use', 'name' => $resolved];
        if ($rel !== null) $payload['meta'] = ['rel' => $rel];
        $this->facts[] = [
            'kind' => 'symbol-use',
            'resolved' => true,
            'location' => $this->loc($where),
            'anchors' => [['key' => 'php-symbol:' . $resolved, 'role' => 'subject']],
            'payload' => $payload,
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
            $this->unresolvedThisProps = [];
            foreach (($p['bind'] ?? []) as $field => $b) {
                $i = $b['arg'];
                $v = $this->readLiteral($args[$i] ?? null, $b['type']);
                if ($v === null && !($b['optional'] ?? false)) $resolved = false;
                if ($v !== null) {
                    $payload[$field] = $v;
                    if (is_string($v) && str_contains($v, '{*}')) $resolved = false;
                }
            }
            if (($p['transform'] ?? null) === 'rest-route') {
                $this->emitRestRouteFacts($n, $payload);
                return;
            }
            if (($p['transform'] ?? null) === 'enqueue-src') {
                $this->emitEnqueueScriptFact($n, $payload);
                return;
            }
            if (($p['transform'] ?? null) === 'admin-page-slug') {
                $this->emitAdminPageRegisterFact($n, $payload, $name);
                return;
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

    /** @param array<string, mixed> $payload */
    private function emitRestRouteFacts(Node $n, array $payload): void
    {
        $namespace = $payload['namespace'] ?? null;
        $route = $payload['route'] ?? null;
        if (!is_string($namespace) || !is_string($route)) {
            $this->facts[] = [
                'kind' => 'rest-endpoint',
                'resolved' => false,
                'location' => $this->loc($n),
                'anchors' => [],
                'payload' => array_merge($payload, ['kind' => 'rest-endpoint']),
            ];
            return;
        }
        $ns = rtrim($namespace, '/');
        $rt = ltrim($route, '/');
        $rt = rtrim($rt, '/');
        $joined = '/' . $ns . ($rt === '' ? '' : '/' . $rt);
        // Collapse any run of slashes — empty namespace/route would yield // or ///.
        $joined = preg_replace('#/+#', '/', $joined) ?? $joined;
        // {*} present BEFORE route-param collapse means an unresolved namespace
        // or route base (skeleton) — a genuine failure. {*} that appears only
        // AFTER collapse is a normalized regex route param — extracted correctly.
        $skeletonWild = str_contains($joined, '{*}');
        $anchorBody   = $this->collapseRouteParams($joined);
        $routeParam   = !$skeletonWild && str_contains($anchorBody, '{*}');
        $resolved     = !$skeletonWild;

        $methods = $this->extractRestMethods($n);
        if ($methods === []) $methods = ['GET'];

        // A $this->prop miss left a {*} in the joined input — record which
        // properties so the cross-file resolver knows what to fill.
        $unresolved = null;
        if ($skeletonWild && $this->unresolvedThisProps !== []) {
            $unresolved = [
                'class'  => (end($this->classStack) ?: null),
                'fields' => array_values(array_unique($this->unresolvedThisProps)),
            ];
        }

        foreach ($methods as $method) {
            $payload = [
                'kind' => 'rest-endpoint',
                'method' => $method,
                'route' => $route,
                'namespace' => $namespace,
            ];
            if ($routeParam) $payload['routeParam'] = true;
            if ($unresolved !== null) $payload['unresolved'] = $unresolved;
            $this->facts[] = [
                'kind' => 'rest-endpoint',
                'resolved' => $resolved,
                'location' => $this->loc($n),
                'anchors' => [['key' => "rest:{$method} {$anchorBody}", 'role' => 'subject']],
                'payload' => $payload,
            ];
        }
    }

    /**
     * Emit an enqueue-script fact, resolving the $src argument (AST arg 1) to a
     * project-relative JS path and attaching a js-module target anchor when the
     * path is a recognized WP enqueue idiom pointing at a JS file.
     *
     * @param array<string, mixed> $payload
     */
    private function emitEnqueueScriptFact(Node $n, array $payload): void
    {
        $anchors = [];
        // Handle side: render the script-handle:{handle} subject anchor as today.
        $handle = $payload['handle'] ?? null;
        $handleResolved = false;
        if (is_string($handle) && $handle !== '') {
            $anchors[] = ['key' => 'script-handle:' . $handle, 'role' => 'subject'];
            $handleResolved = !str_contains($handle, '{*}');
        }

        // $src side: resolve arg 1 to a project-relative JS path.
        $args = $this->extractArgs($n);
        $srcPath = $this->resolveEnqueueSrc($args[1] ?? null);
        $jsModuleEmitted = false;
        if ($srcPath !== null && $srcPath !== '' && !str_contains($srcPath, '{*}')
            && preg_match('/\.(mjs|cjs|jsx|tsx|ts|js)$/i', $srcPath) === 1) {
            $anchors[] = ['key' => 'js-module:' . $srcPath, 'role' => 'target'];
            $payload['srcPath'] = $srcPath;
            $jsModuleEmitted = true;
        }

        $payload['kind'] = 'enqueue-script';
        $this->facts[] = [
            'kind' => 'enqueue-script',
            // resolved iff BOTH the handle anchor and a js-module anchor landed.
            'resolved' => $handleResolved && $jsModuleEmitted,
            'location' => $this->loc($n),
            'anchors' => $anchors,
            'payload' => $payload,
        ];
    }

    /**
     * Emit an admin-page-register fact for add_menu_page / add_submenu_page
     * (program Phase 5). The menu_slug is already bound into $payload['slug']
     * as a readStringSkeleton result: a pure literal ('wc-settings'), a
     * concat-with-literal-head ('wc-orders{*}'), or — when fully dynamic — the
     * bare string '{*}' (or absent). A fully-dynamic slug carries no static
     * anchor and is the project-wrapper indirection the spec declares out of
     * scope, so the fact is dropped.
     *
     * @param array<string, mixed> $payload
     */
    private function emitAdminPageRegisterFact(Node $n, array $payload, ?string $name): void
    {
        $slug = $payload['slug'] ?? null;
        if (!is_string($slug) || $slug === '' || $slug === '{*}') {
            return;
        }
        $fn = $name === 'add_submenu_page' ? 'add_submenu_page' : 'add_menu_page';
        $resolved = !str_contains($slug, '{*}');
        $this->facts[] = [
            'kind' => 'admin-page-register',
            'resolved' => $resolved,
            'location' => $this->loc($n),
            'anchors' => [['key' => 'wp-admin-page:' . $slug, 'role' => 'subject']],
            'payload' => [
                'kind' => 'admin-page-register',
                'slug' => $slug,
                'fn' => $fn,
            ],
        ];
    }

    /**
     * Resolve a wp_enqueue_script $src argument node to a project-relative
     * POSIX path, or null when the shape is not a recognized WP enqueue idiom.
     * Pattern-shaped: a fixed named idiom set, no inter-procedural analysis.
     */
    private function resolveEnqueueSrc(?Node $node): ?string
    {
        if ($node === null) return null;

        // bare string literal — '/wp-admin/js/inline-edit-post.js' style.
        if ($node instanceof Node\Scalar\String_) {
            $v = $node->value;
            if ($v === '') return null;
            // A leading '/' marks a site-root path; strip it to project-relative.
            return $this->normalizeIncludePath(ltrim($v, '/'));
        }

        // plugins_url(LITERAL, __FILE__).
        if ($node instanceof Node\Expr\FuncCall && $node->name instanceof Node\Name) {
            $fn = $node->name->toString();
            if ($fn === 'plugins_url') {
                $args = $this->extractArgs($node);
                $lit = isset($args[0]) && $args[0] instanceof Node\Scalar\String_
                    ? $args[0]->value : null;
                if ($lit === null) return null;
                $base = dirname($this->relFile);
                $joined = ($base === '.' ? '' : $base . '/') . $lit;
                return $this->normalizeIncludePath($joined);
            }
            return null;
        }

        // CONCAT — left side a directory expression, right side the literal tail.
        if ($node instanceof Node\Expr\BinaryOp\Concat) {
            $tail = $this->readStringSkeleton($node->right);
            if ($tail === null || str_contains($tail, '{*}')) return null;
            $base = $this->resolveEnqueueDirBase($node->left);
            if ($base === null) return null;
            $joined = ($base === '' ? '' : $base . '/') . ltrim($tail, '/');
            return $this->normalizeIncludePath($joined);
        }

        return null;
    }

    /**
     * Resolve the directory-base expression on the left of a $src concat.
     * Returns a project-relative directory, or null when not a known idiom.
     */
    private function resolveEnqueueDirBase(?Node $node): ?string
    {
        if ($node === null) return null;
        // get_template_directory_uri() / get_stylesheet_directory_uri() /
        // plugin_dir_url(__FILE__): the theme/plugin root is, in practice, the
        // directory of the enqueuing file (theme functions.php sits at root).
        if ($node instanceof Node\Expr\FuncCall && $node->name instanceof Node\Name) {
            $fn = $node->name->toString();
            if (in_array($fn, [
                'get_template_directory_uri', 'get_stylesheet_directory_uri',
                'plugin_dir_url', 'get_theme_file_uri',
            ], true)) {
                $d = dirname($this->relFile);
                return $d === '.' ? '' : $d;
            }
            return null;
        }
        // CONST resolving to a path via define().
        if ($node instanceof Node\Expr\ConstFetch) {
            $name = $node->name->toString();
            return isset($this->defines[$name])
                ? $this->normalizeIncludePath($this->defines[$name]) : null;
        }
        // A nested concat (dir-expr . '/sub'): recurse + skeleton-read the tail.
        if ($node instanceof Node\Expr\BinaryOp\Concat) {
            $base = $this->resolveEnqueueDirBase($node->left);
            $tail = $this->readStringSkeleton($node->right);
            if ($base === null || $tail === null || str_contains($tail, '{*}')) return null;
            return $this->normalizeIncludePath(
                ($base === '' ? '' : $base . '/') . ltrim($tail, '/'),
            );
        }
        return null;
    }

    /**
     * Collapse every PCRE named-group route param — (?P<n>…), (?<n>…) — to {*}.
     * Brace-matched: tracks paren depth and treats [...] as a char-class span
     * in which ( and ) are literal. A regex cannot do this (nested parens,
     * ) inside a char class), hence a scanner.
     */
    private function collapseRouteParams(string $route): string
    {
        $out = '';
        $len = strlen($route);
        $i = 0;
        while ($i < $len) {
            $isNamed = (substr($route, $i, 4) === '(?P<') || (substr($route, $i, 3) === '(?<');
            if (!$isNamed) {
                $out .= $route[$i];
                $i++;
                continue;
            }
            // Consume the whole group, brace-matched.
            $depth = 0;
            $inClass = false;
            while ($i < $len) {
                $ch = $route[$i];
                if ($inClass) {
                    if ($ch === ']') $inClass = false;
                } elseif ($ch === '[') {
                    $inClass = true;
                } elseif ($ch === '(') {
                    $depth++;
                } elseif ($ch === ')') {
                    $depth--;
                    if ($depth === 0) { $i++; break; }
                }
                $i++;
            }
            $out .= '{*}';
        }
        return $out;
    }

    /** @return list<string> */
    private function extractRestMethods(Node $n): array
    {
        $args = $this->extractArgs($n);
        $argsNode = $args[2] ?? null;
        if (!$argsNode instanceof Node\Expr\Array_) return [];
        foreach ($argsNode->items as $item) {
            if (!$item instanceof Node\ArrayItem) continue;
            if (!$item->key instanceof Node\Scalar\String_) continue;
            if (strtolower($item->key->value) !== 'methods') continue;
            $val = $item->value;
            if ($val instanceof Node\Scalar\String_) {
                return $this->splitMethods($val->value);
            }
            if ($val instanceof Node\Expr\Array_) {
                $out = [];
                foreach ($val->items as $m) {
                    if ($m instanceof Node\ArrayItem && $m->value instanceof Node\Scalar\String_) {
                        $out = array_merge($out, $this->splitMethods($m->value->value));
                    }
                }
                return $out;
            }
            return [];
        }
        return [];
    }

    /** @return list<string> */
    private function splitMethods(string $raw): array
    {
        $parts = preg_split('/\s*,\s*/', strtoupper(trim($raw))) ?: [];
        return array_values(array_filter($parts, fn ($p) => $p !== ''));
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

    private function normalizeIncludePath(string $p): string
    {
        $p = str_replace('\\', '/', $p);
        $p = preg_replace('#/+#', '/', $p) ?? $p;
        $segments = [];
        foreach (explode('/', $p) as $seg) {
            if ($seg === '' || $seg === '.') continue;
            if ($seg === '..') { array_pop($segments); continue; }
            $segments[] = $seg;
        }
        return implode('/', $segments);
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
        if ($node instanceof Node\Scalar\Encapsed) {
            $out = '';
            foreach ($node->parts as $part) {
                if ($part instanceof Node\Scalar\EncapsedStringPart) {
                    $out .= $part->value;
                } else {
                    $out .= '{*}';
                }
            }
            return $out;
        }
        if ($node instanceof Node\Scalar\MagicConst\Dir) {
            $d = dirname($this->relFile);
            return $d === '.' ? '' : $d;
        }
        if ($node instanceof Node\Scalar\MagicConst\File) {
            return $this->relFile;
        }
        if ($node instanceof Node\Expr\ConstFetch) {
            $name = $node->name->toString();
            if (isset($this->defines[$name])) return $this->defines[$name];
            return null;
        }
        if ($node instanceof Node\Expr\ClassConstFetch) {
            if (!$node->name instanceof Node\Identifier) return null;
            $constName = $node->name->name;
            if (!($node->class instanceof Node\Name)) return null;
            $raw = $node->class->toString();
            $lower = strtolower($raw);
            // self/static: resolve against current class stack lexically.
            // resolveClassName would (wrongly) prepend the namespace, so
            // short-circuit here before any normalization.
            if (!$node->class->isFullyQualified() && ($lower === 'self' || $lower === 'static')) {
                $current = end($this->classStack);
                if ($current !== false && isset($this->classConsts[$current][$constName])) {
                    return $this->classConsts[$current][$constName];
                }
                return null;
            }
            // parent::CONST not handled in v1; would need a parent-class index.
            if (!$node->class->isFullyQualified() && $lower === 'parent') return null;
            $className = $this->resolveClassName($node->class);
            if (isset($this->classConsts[$className][$constName])) {
                return $this->classConsts[$className][$constName];
            }
            return null;
        }
        if ($node instanceof Node\Expr\PropertyFetch
            && $node->var instanceof Node\Expr\Variable
            && $node->var->name === 'this'
            && $node->name instanceof Node\Identifier) {
            $current = end($this->classStack);
            if ($current !== false && isset($this->classProps[$current][$node->name->name])) {
                return $this->classProps[$current][$node->name->name];
            }
            // Known to be a $this->prop fragment but its default is not a
            // string literal — skeletonize rather than drop the whole fact.
            // Record the property name so the cross-file resolver can fill it
            // from an inherited declaration.
            $this->unresolvedThisProps[] = $node->name->name;
            return '{*}';
        }
        return null;
    }

    /**
     * Pre-pass walk to populate $defines from top-level `const` and `define()`
     * calls before the main visitor walks the AST. Visits the SAME AST.
     *
     * @param array<int, Node> $ast
     */
    public function prePass(array $ast): void
    {
        $this->defines = [];
        $this->classConsts = [];
        $this->classProps = [];
        $traverser = new NodeTraverser();
        $defines = &$this->defines;
        $classConsts = &$this->classConsts;
        $classProps = &$this->classProps;
        $finder = new class($defines, $classConsts, $classProps) extends NodeVisitorAbstract {
            private ?string $ns = null;
            /** @var list<string> */
            private array $stack = [];
            /** Whether the walk is currently inside a class-method body. */
            private bool $inMethod = false;
            /** Nesting depth inside if/loop/closure/etc. within the current method. */
            private int $nesting = 0;
            /**
             * Per-property provenance, prePass-local. 'default' = declared default,
             * 'assign' = method/constructor assignment. An assignment never loses to
             * a default; a default never overwrites an assignment.
             * @var array<string, array<string, string>>
             */
            private array $origin = [];
            /**
             * Properties that received two differing assignment literals. Their
             * $classProps entry is removed so readStringSkeleton falls back to {*}.
             * @var array<string, array<string, true>>
             */
            private array $ambiguous = [];
            /** Statement node kinds that introduce conditional / scoped nesting. */
            private const NESTING_NODES = [
                Node\Stmt\If_::class, Node\Stmt\ElseIf_::class, Node\Stmt\Else_::class,
                Node\Stmt\For_::class, Node\Stmt\Foreach_::class, Node\Stmt\While_::class,
                Node\Stmt\Do_::class, Node\Stmt\Switch_::class, Node\Stmt\TryCatch::class,
                Node\Stmt\Catch_::class, Node\Expr\Closure::class,
                Node\Expr\ArrowFunction::class, Node\Expr\Match_::class,
            ];

            /**
             * @param array<string, string> $defines
             * @param array<string, array<string, string>> $classConsts
             * @param array<string, array<string, string>> $classProps
             */
            public function __construct(
                private array &$defines,
                private array &$classConsts,
                private array &$classProps,
            ) {}
            public function enterNode(Node $node): void
            {
                if ($node instanceof Node\Stmt\Namespace_) {
                    $this->ns = $node->name?->toString();
                    return;
                }
                if ($node instanceof Node\Stmt\ClassLike && $node->name !== null) {
                    $fqn = $this->ns !== null ? $this->ns . '\\' . $node->name->name : $node->name->name;
                    $this->stack[] = $fqn;
                    $this->classConsts[$fqn] ??= [];
                    $this->classProps[$fqn] ??= [];
                    return;
                }
                if ($node instanceof Node\Stmt\ClassMethod) {
                    $this->inMethod = true;
                    $this->nesting = 0;
                    return;
                }
                if ($this->inMethod && in_array(get_class($node), self::NESTING_NODES, true)) {
                    $this->nesting++;
                    return;
                }
                if ($node instanceof Node\Stmt\ClassConst) {
                    $current = end($this->stack);
                    if ($current !== false) {
                        foreach ($node->consts as $c) {
                            if ($c->value instanceof Node\Scalar\String_) {
                                $this->classConsts[$current][$c->name->name] = $c->value->value;
                            }
                        }
                    }
                    return;
                }
                if ($node instanceof Node\Stmt\Property) {
                    $current = end($this->stack);
                    if ($current !== false) {
                        foreach ($node->props as $p) {
                            if (!$p->default instanceof Node\Scalar\String_) continue;
                            $name = $p->name->name;
                            // A default never overwrites an assignment-sourced entry.
                            if (($this->origin[$current][$name] ?? null) === 'assign') continue;
                            $this->classProps[$current][$name] = $p->default->value;
                            $this->origin[$current][$name] = 'default';
                        }
                    }
                    return;
                }
                if ($node instanceof Node\Expr\Assign
                    && $this->inMethod
                    && $this->nesting === 0
                    && $node->var instanceof Node\Expr\PropertyFetch
                    && $node->var->var instanceof Node\Expr\Variable
                    && $node->var->var->name === 'this'
                    && $node->var->name instanceof Node\Identifier) {
                    $current = end($this->stack);
                    if ($current !== false) {
                        $this->recordPropAssign($current, $node->var->name->name, $node->expr);
                    }
                    return;
                }
                if ($node instanceof Node\Stmt\Const_) {
                    foreach ($node->consts as $c) {
                        if ($c->value instanceof Node\Scalar\String_) {
                            $this->defines[$c->name->name] = $c->value->value;
                        }
                    }
                    return;
                }
                if ($node instanceof Node\Expr\FuncCall
                    && $node->name instanceof Node\Name
                    && strtolower($node->name->toString()) === 'define'
                    && count($node->args) >= 2
                    && $node->args[0] instanceof Node\Arg
                    && $node->args[1] instanceof Node\Arg
                    && $node->args[0]->value instanceof Node\Scalar\String_
                    && $node->args[1]->value instanceof Node\Scalar\String_) {
                    $this->defines[$node->args[0]->value->value] = $node->args[1]->value->value;
                }
            }

            public function leaveNode(Node $node): void
            {
                if ($node instanceof Node\Stmt\Namespace_) $this->ns = null;
                if ($node instanceof Node\Stmt\ClassLike) array_pop($this->stack);
                if ($node instanceof Node\Stmt\ClassMethod) {
                    $this->inMethod = false;
                    $this->nesting = 0;
                    return;
                }
                if ($this->inMethod && $this->nesting > 0
                    && in_array(get_class($node), self::NESTING_NODES, true)) {
                    $this->nesting--;
                }
            }

            /** Record a top-level $this->prop = <rhs> assignment, honoring ambiguity. */
            private function recordPropAssign(string $fqcn, string $prop, Node $rhs): void
            {
                if (isset($this->ambiguous[$fqcn][$prop])) return;
                $literal = $this->readPrePassLiteral($rhs);
                if ($literal === null) return;
                $existing = $this->classProps[$fqcn][$prop] ?? null;
                $existingOrigin = $this->origin[$fqcn][$prop] ?? null;
                if ($existing !== null && $existingOrigin === 'assign' && $existing !== $literal) {
                    // Two differing assignment literals — indeterminate at the use site.
                    $this->ambiguous[$fqcn][$prop] = true;
                    unset($this->classProps[$fqcn][$prop]);
                    return;
                }
                $this->classProps[$fqcn][$prop] = $literal;
                $this->origin[$fqcn][$prop] = 'assign';
            }

            /** Resolve an assignment RHS to a plain string, or null if not statically known. */
            private function readPrePassLiteral(Node $rhs): ?string
            {
                if ($rhs instanceof Node\Scalar\String_) return $rhs->value;
                if ($rhs instanceof Node\Expr\ConstFetch) {
                    return $this->defines[$rhs->name->toString()] ?? null;
                }
                if ($rhs instanceof Node\Expr\ClassConstFetch
                    && $rhs->name instanceof Node\Identifier
                    && $rhs->class instanceof Node\Name) {
                    $constName = $rhs->name->name;
                    $raw = $rhs->class->toString();
                    $lower = strtolower($raw);
                    if (!$rhs->class->isFullyQualified() && ($lower === 'self' || $lower === 'static')) {
                        $current = end($this->stack);
                        if ($current === false) return null;
                        return $this->classConsts[$current][$constName] ?? null;
                    }
                    if (!$rhs->class->isFullyQualified() && $lower === 'parent') return null;
                    $className = $rhs->class->isFullyQualified()
                        ? ltrim($raw, '\\')
                        : ($this->ns !== null ? $this->ns . '\\' . $raw : $raw);
                    return $this->classConsts[$className][$constName] ?? null;
                }
                return null;
            }
        };
        $traverser->addVisitor($finder);
        $traverser->traverse($ast);
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
            $visitor->prePass($ast);
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
    // JSON_INVALID_UTF8_SUBSTITUTE: source string literals can carry binary
    // escapes (e.g. MaxMind's "\xab\xcd\xefMaxMind.com") that the parser turns
    // into invalid-UTF-8 byte strings. Without the flag json_encode returns
    // false, emit writes a bare "\n", and the host protocol — which drops empty
    // lines — leaves its request promise unresolved until the worker is reaped.
    // Substituting U+FFFD keeps the response well-formed.
    $json = json_encode($msg, JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);
    if ($json === false) {
        $json = json_encode(['op' => 'error', 'message' => 'json_encode failed: ' . json_last_error_msg()]);
    }
    fwrite(STDOUT, $json . "\n");
    fflush(STDOUT);
}
