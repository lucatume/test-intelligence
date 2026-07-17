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
    /** Raw file source — sliced by getStart/EndFilePos for expression text. */
    private string $code = '';
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
    /**
     * Per-function/method literal local-variable assignments (H1).
     * Keyed <scopeKey> => <varName> => <literal>. Populated by prePass.
     * @var array<string, array<string, string>>
     */
    private array $localVars = [];
    /** @var list<string> Scope keys (<name>@<startLine>) for the enclosing function/method chain. */
    private array $scopeStack = [];
    /** @var list<string> Property names hit as $this->prop misses during the current arg-binding cycle. */
    private array $unresolvedThisProps = [];
    /**
     * Array-literal-valued local variables, keyed <scope> => <varName> =>
     * list<string>. Populated flow-sensitively during the main walk from
     * `$var = array(...)` assignments. Source for foreach / in_array unrolling.
     * @var array<string, array<string, list<string>>>
     */
    private array $localArrays = [];
    /**
     * Stack of active enumeration bindings. Each frame maps the source text of
     * an enumerated expression (a foreach value-variable, or an in_array
     * needle) to the list of string literals it ranges over. Pushed on
     * entering a Foreach_ / If_ node, popped on leaving it — so a loop
     * variable reused across sibling loops never cross-contaminates.
     * @var list<array<string, list<string>>>
     */
    private array $enumStack = [];

    /**
     * Index of same-file top-level function wrappers: functions whose body
     * directly calls a WP_PHP_PATTERNS callee with literal or param-fed args.
     * Keyed by wrapper function name; each entry is a list of wrapper specs.
     * @var array<string, list<array{wraps:string,defFile:string,defStartLine:int,argSpecs:list<array<string,mixed>>}>>
     */
    private array $wrapperIndex = [];

    /**
     * Lookup set of WP_PHP_PATTERNS callee names (from Patterns::$entries).
     * Populated lazily on first use; reset per-file in prePass.
     * @var array<string, true>|null
     */
    private ?array $patternCallees = null;

    /**
     * Set of scope keys (name@startLine) for functions that are indexed as
     * wrappers. Used to suppress declarative emission inside wrapper bodies.
     * @var array<string, true>
     */
    private array $wrapperScopes = [];

    /** @var list<array{callee:string,serializedArgs:list<mixed>,file:string,startLine:int,endLine:int}> */
    private array $deferredWrapperCalls = [];

    /**
     * When true: the host has signalled that $wrapperIndex is the complete
     * build-wide union (post-barrier). prePass skips buildWrapperIndex
     * (re-running it would duplicate auto entries); wrapperScopes is seeded
     * from the complete index; FuncCall and method-call defer branches are
     * disabled — a name absent from the complete index is definitively not a
     * wrapper. Set per-request by the extract op handler.
     */
    private bool $wrapperIndexComplete = false;

    /**
     * Facts synthesized during eager replay (called after each prePass to keep
     * the deferred queue bounded). These are collected here instead of emitted
     * immediately so the per-file extract response stays clean (only facts for
     * the current file). They are emitted as part of flush-deferred output.
     * @var list<array<string, mixed>>
     */
    private array $earlyFlushedFacts = [];

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

    public function __construct(string $file, ?string $relFile = null, string $code = '')
    {
        $this->file = $file;
        // Project-relative POSIX path used in test_ids + anchor keys so
        // outputs are portable across machines. When omitted, the absolute
        // path is the fallback identifier.
        $this->relFile = $relFile ?? $file;
        $this->code = $code;
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
            $this->emitCoversUses($node, $node->getDocComment()?->getText() ?? '');
            return;
        }
        if ($node instanceof Node\Stmt\Function_) {
            $name = $this->namespace ? $this->namespace . '\\' . $node->name->name : $node->name->name;
            $this->facts[] = $this->factSymbolDef($node, $name, true, true);
            $scopeKey = $node->name->name . '@' . ($node->getStartLine() ?: 0);
            $this->scopeStack[] = $scopeKey;
            // If the prePass indexed this function as a called wrapper, suppress
            // declarative emission inside its body.
            if (isset($this->wrapperIndex[$node->name->name])) {
                $this->wrapperScopes[$scopeKey] = true;
            }
            return;
        }
        if ($node instanceof Node\Stmt\ClassMethod && !empty($this->classStack)) {
            $class = end($this->classStack);
            $fqn = $class . '::' . $node->name->name;
            $this->facts[] = $this->factSymbolDef($node, $fqn, false, true);
            if ($this->classIsPhpUnit && $this->isPhpUnitTestMethod($node)) {
                $this->facts[] = $this->factTestDef($node, $class, $node->name->name);
                $this->emitDataProviderUses($node, $class);
            }
            $this->emitCoversUses($node, $node->getDocComment()?->getText() ?? '');
            $scopeKey = $node->name->name . '@' . ($node->getStartLine() ?: 0);
            $this->scopeStack[] = $scopeKey;
            // If the prePass indexed this class method as a wrapper, suppress
            // declarative emission inside its body. Mirror of the Function_
            // branch above: a method that wraps a pattern callee should only
            // emit synthesized facts at its call sites, not at the pattern
            // callee inside its body.
            foreach ($this->wrapperIndex[$node->name->name] ?? [] as $entry) {
                if (($entry['kind'] ?? 'function') !== 'method') continue;
                if (($entry['class'] ?? null) !== $class) continue;
                $this->wrapperScopes[$scopeKey] = true;
                break;
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
                    'payload' => [
                        'kind' => 'php-include',
                        'target' => '{*}',
                        'unresolved' => $this->buildUnresolvedBlock(
                            [['field' => 'target', 'node' => $node->expr]],
                        ),
                    ],
                ];
                return;
            }
            $hasWildcard = str_contains($raw, '{*}');
            $target = $hasWildcard ? $raw : $this->normalizeIncludePath($raw);
            $resolved = !$hasWildcard;
            $includePayload = ['kind' => 'php-include', 'target' => $target];
            if (!$resolved) {
                $includePayload['unresolved'] = $this->buildUnresolvedBlock(
                    [['field' => 'target', 'node' => $node->expr]],
                );
            }
            $this->facts[] = [
                'kind' => 'php-include',
                'resolved' => $resolved,
                'location' => $this->loc($node),
                'anchors' => [['key' => 'php-file:' . $target, 'role' => 'target']],
                'payload' => $includePayload,
            ];
            return;
        }
        if ($node instanceof Node\Stmt\If_) {
            $frame = [];
            $guard = $this->findInArrayGuard($node->cond);
            if ($guard !== null) {
                $values = $this->resolveArraySource($guard[1]);
                $key = $this->nodeText($guard[0]);
                if ($values !== null && $values !== [] && $key !== null) {
                    $frame[$key] = $values;
                }
            }
            $this->enumStack[] = $frame;
            return;
        }
        // Record `$var = array(...)` for foreach / in_array unrolling, keyed
        // by enclosing named scope. Flow-sensitive, last write wins. Unlike H1
        // `localVars`, assignments at any nesting depth are recorded — a
        // closure body's array literal must resolve for a foreach inside that
        // same closure; the accepted cost is a closure-body reassignment
        // shadowing a same-named enclosing-scope array. The early return ends
        // handling of this node; the traverser still descends into the RHS.
        if ($node instanceof Node\Expr\Assign
            && $node->var instanceof Node\Expr\Variable
            && is_string($node->var->name)) {
            $values = $this->resolveArraySource($node->expr);
            if ($values !== null) {
                $this->localArrays[$this->currentScope()][$node->var->name] = $values;
            }
            return;
        }
        if ($node instanceof Node\Stmt\Foreach_) {
            $frame = [];
            if ($node->valueVar instanceof Node\Expr\Variable && is_string($node->valueVar->name)) {
                $values = $this->resolveArraySource($node->expr);
                $key = $this->nodeText($node->valueVar);
                if ($values !== null && $values !== [] && $key !== null) {
                    $frame[$key] = $values;
                }
            }
            $this->enumStack[] = $frame;
            return;
        }
        if ($node instanceof Node\Expr\FuncCall) {
            $name = $this->funcName($node);
            // Check the entire scope stack — a closure inside a wrapper body
            // also counts as "in wrapper body" (top of stack is "\0closure").
            $inWrapperBody = false;
            foreach ($this->scopeStack as $frame) {
                if (isset($this->wrapperScopes[$frame])) { $inWrapperBody = true; break; }
            }
            if (!$inWrapperBody) {
                $this->tryEmitDeclarative('function-call', $node, $name, null);
            }
            if ($name !== null && isset($this->wrapperIndex[$name])) {
                $this->synthesizeWrappedCall($name, $node->args, $node);
            } elseif (!$this->wrapperIndexComplete
                && $name !== null
                && !self::isBuiltinFunction($name)
                && !isset($this->getPatternCallees()[$name])
                && !$inWrapperBody
            ) {
                // Single-pass mode only: callee not yet in the wrapper index
                // and not a known pattern callee or builtin — buffer for
                // cross-file deferred replay. The wrapper definition may
                // arrive in a later file's prePass.
                //
                // Store pre-resolved scalar arg values instead of live AST
                // Node objects. Keeping Node references alive prevents PHP from
                // GC-ing the file's entire AST, causing memory growth O(N)
                // in the number of files. Scalars are tiny; reconstruction at
                // replay time uses literalToNode() which the synthesis path
                // already accepts.
                $serializedArgs = $this->serializeArgsForDeferred($node->args);
                $this->deferredWrapperCalls[] = [
                    'callee'    => $name,
                    'serializedArgs' => $serializedArgs,
                    'file'      => $this->file,
                    'startLine' => $node->getStartLine(),
                    'endLine'   => $node->getEndLine(),
                ];
            }
            if ($name !== null && !self::isBuiltinFunction($name)) {
                $resolved = $this->resolveName($name);
                $this->facts[] = [
                    'kind' => 'symbol-use',
                    'resolved' => true,
                    'location' => $this->loc($node),
                    'anchors' => [['key' => 'php-symbol:' . $resolved, 'role' => 'subject']],
                    'payload' => ['kind' => 'symbol-use', 'name' => $resolved],
                ];
            }
            return;
        }
        if ($node instanceof Node\Expr\MethodCall) {
            $name = $node->name instanceof Node\Identifier ? $node->name->name : null;
            $recv = $node->var instanceof Node\Expr\Variable && is_string($node->var->name) ? $node->var->name : null;
            if ($name !== null) $this->tryEmitDeclarative('method-call', $node, $name, $recv);
            if ($name !== null) {
                $inWrapperBody = false;
                foreach ($this->scopeStack as $frame) {
                    if (isset($this->wrapperScopes[$frame])) { $inWrapperBody = true; break; }
                }
                $isThis = $node->var instanceof Node\Expr\Variable
                    && is_string($node->var->name)
                    && $node->var->name === 'this'
                    && !empty($this->classStack);
                $lookupClass = $isThis ? end($this->classStack) : null;
                $callKind = $isThis ? 'method-this' : 'method-instance';
                $this->trySynthesizeMethodWrapper($name, $node->args, $node, $lookupClass, $callKind, $inWrapperBody);
                if ($this->classIsPhpUnit && $isThis && is_string($lookupClass)) {
                    $this->emitMethodUse($node, $lookupClass . '::' . $name);
                }
            }
            return;
        }
        if ($node instanceof Node\Expr\StaticCall) {
            $name = $node->name instanceof Node\Identifier ? $node->name->name : null;
            $lookupClass = null;
            if ($node->class instanceof Node\Name) {
                $this->emitClassUse($node, $node->class);
                $raw = strtolower($node->class->toString());
                if (($raw === 'self' || $raw === 'static') && !empty($this->classStack)) {
                    $lookupClass = end($this->classStack);
                } else {
                    $lookupClass = $this->resolveClassName($node->class);
                }
                $recv = $lookupClass;
            } else {
                $recv = null;
            }
            if ($name !== null) $this->tryEmitDeclarative('static-call', $node, $name, $recv);
            if ($name !== null) {
                $inWrapperBody = false;
                foreach ($this->scopeStack as $frame) {
                    if (isset($this->wrapperScopes[$frame])) { $inWrapperBody = true; break; }
                }
                $this->trySynthesizeMethodWrapper($name, $node->args, $node, $lookupClass, 'static-method', $inWrapperBody);
                if ($this->classIsPhpUnit && is_string($lookupClass)) {
                    $this->emitMethodUse($node, $lookupClass . '::' . $name);
                }
            }
            return;
        }
        if ($node instanceof Node\Expr\New_) {
            if ($node->class instanceof Node\Name) {
                $this->emitClassUse($node, $node->class);
                $this->tryEmitDeclarative('new-expression', $node, $node->class->getLast(), null);
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
        if ($node instanceof Node\Expr\Closure || $node instanceof Node\Expr\ArrowFunction) {
            // A closure body opens no recordable local-variable scope (H1):
            // its assignments sit at nesting > 0 of the enclosing function in
            // the pre-pass and are never recorded. Push a sentinel so variable
            // uses inside the closure resolve against nothing → {*}.
            $this->scopeStack[] = "\0closure";
            return;
        }
    }

    public function leaveNode(Node $node): void
    {
        if ($node instanceof Node\Stmt\Namespace_) $this->namespace = null;
        if ($node instanceof Node\Stmt\ClassLike && $node->name !== null) {
            array_pop($this->classStack);
            $this->classIsPhpUnit = false;
        }
        if ($node instanceof Node\Stmt\Function_) {
            array_pop($this->scopeStack);
        }
        if ($node instanceof Node\Stmt\ClassMethod && !empty($this->classStack)) {
            array_pop($this->scopeStack);
        }
        if ($node instanceof Node\Stmt\Foreach_) {
            array_pop($this->enumStack);
        }
        if ($node instanceof Node\Stmt\If_) {
            array_pop($this->enumStack);
        }
        if ($node instanceof Node\Expr\Closure || $node instanceof Node\Expr\ArrowFunction) {
            array_pop($this->scopeStack);
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
    private function factSymbolDef(Node $n, string $name, bool $exported, bool $callable = false): array
    {
        // role: 'target' — definitions are the destination of references.
        // symbol-use facts at role 'subject' bridge here via the anchor index.
        return [
            'kind' => 'symbol-def',
            'resolved' => true,
            'location' => $this->loc($n),
            'anchors' => [['key' => 'php-symbol:' . $name, 'role' => 'target']],
            'payload' => array_filter([
                'kind' => 'symbol-def',
                'name' => $name,
                'exported' => $exported,
                'meta' => $callable ? ['callable' => true] : null,
            ], static fn($value) => $value !== null),
        ];
    }

    private function emitMethodUse(Node $node, string $name, ?array $meta = null): void
    {
        $payload = ['kind' => 'symbol-use', 'name' => $name];
        if ($meta !== null) $payload['meta'] = $meta;
        $this->facts[] = [
            'kind' => 'symbol-use',
            'resolved' => true,
            'location' => $this->loc($node),
            'anchors' => [['key' => 'php-symbol:' . $name, 'role' => 'subject']],
            'payload' => $payload,
        ];
    }

    private function emitDataProviderUses(Node\Stmt\ClassMethod $method, string $class): void
    {
        $doc = $method->getDocComment()?->getText() ?? '';
        if (preg_match_all('/@dataProvider\s+([^\s*]+)/', $doc, $matches)) {
            foreach ($matches[1] as $provider) {
                $this->emitMethodUse($method, $class . '::' . rtrim((string)$provider, '()'), ['provider' => true]);
            }
        }
        foreach ($method->attrGroups as $group) {
            foreach ($group->attrs as $attr) {
                $short = $attr->name->getLast();
                if ($short === 'DataProvider') {
                    $arg = $attr->args[0]->value ?? null;
                    if ($arg instanceof Node\Scalar\String_) {
                        $this->emitMethodUse($method, $class . '::' . $arg->value, ['provider' => true]);
                    }
                } elseif ($short === 'DataProviderExternal') {
                    $classArg = $attr->args[0]->value ?? null;
                    $methodArg = $attr->args[1]->value ?? null;
                    if ($classArg instanceof Node\Expr\ClassConstFetch
                        && $classArg->class instanceof Node\Name
                        && $methodArg instanceof Node\Scalar\String_) {
                        $providerClass = $this->resolveClassName($classArg->class);
                        $this->emitMethodUse($method, $providerClass . '::' . $methodArg->value, ['provider' => true]);
                    }
                }
            }
        }
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

    private function emitCoversUses(Node $node, string $doc): void
    {
        if ($doc === '' || !preg_match_all('/@covers\s+([^\s*]+)/', $doc, $matches)) return;
        foreach ($matches[1] as $raw) {
            $raw = rtrim((string)$raw, '()');
            if ($raw === '') continue;
            if (str_starts_with($raw, '::')) {
                $name = $this->resolveName(substr($raw, 2));
            } elseif (str_contains($raw, '::')) {
                [$class, $method] = explode('::', $raw, 2);
                $name = $this->resolveClassName(new Node\Name($class)) . '::' . rtrim($method, '()');
            } else {
                $name = $this->resolveClassName(new Node\Name($raw));
            }
            $this->facts[] = [
                'kind' => 'symbol-use',
                'resolved' => true,
                'location' => $this->loc($node),
                'anchors' => [['key' => 'php-symbol:' . $name, 'role' => 'subject']],
                'payload' => ['kind' => 'symbol-use', 'name' => $name, 'meta' => ['covers' => true]],
            ];
        }
    }

    private function emitPhpBinaryScript(Node $node): void
    {
        $args = $this->extractArgs($node);
        $command = $args[0] ?? null;
        if (!$command instanceof Node\Expr\Array_ || count($command->items) < 2) return;
        $binary = $command->items[0]?->value;
        if (!$binary instanceof Node\Expr\ConstFetch || strtoupper($binary->name->toString()) !== 'PHP_BINARY') return;
        $raw = $this->readStringSkeleton($command->items[1]?->value);
        if ($raw === null || $raw === '' || str_contains($raw, '{*}')) return;
        $target = $this->normalizeIncludePath($raw);
        if ($target === '' || !str_ends_with(strtolower($target), '.php')) return;
        $this->facts[] = [
            'kind' => 'php-include',
            'resolved' => true,
            'location' => $this->loc($node),
            'anchors' => [['key' => 'php-file:' . $target, 'role' => 'target']],
            'payload' => ['kind' => 'php-include', 'target' => $target],
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

    /**
     * Stable enclosing-scope string: Class\Fqn::method, function, or '(file)'.
     * Walks past closure sentinels to the nearest named frame. The @<line>
     * suffix on scopeStack frames is dropped — it would make the hash
     * position-dependent.
     */
    private function currentScope(): string
    {
        $fn = null;
        for ($i = count($this->scopeStack) - 1; $i >= 0; $i--) {
            $frame = $this->scopeStack[$i];
            if ($frame === "\0closure") continue;
            $at = strrpos($frame, '@');
            $fn = $at === false ? $frame : substr($frame, 0, $at);
            break;
        }
        $class = end($this->classStack);
        if ($class !== false) {
            return $fn !== null ? $class . '::' . $fn : $class;
        }
        return $fn !== null ? $fn : '(file)';
    }

    /**
     * Build the shared partial-fact resolution context: enclosing scope,
     * per-field unresolved expressions (source text sliced from $code by file
     * position), and a stable sha256 content hash. Additive metadata only.
     *
     * @param array<int, array{field: string, node: ?Node}> $failed
     * @return array{scope: string, fields: list<array{field: string, expression: string}>, exprHash: string}
     */
    private function buildUnresolvedBlock(array $failed): array
    {
        $scope = $this->currentScope();
        $fields = [];
        foreach ($failed as $f) {
            $expr = '';
            $node = $f['node'];
            if ($node !== null) {
                $start = $node->getStartFilePos();
                $end = $node->getEndFilePos();
                if ($start >= 0 && $end >= $start && $this->code !== '') {
                    $expr = substr($this->code, $start, $end - $start + 1);
                }
            }
            $fields[] = ['field' => $f['field'], 'expression' => $expr];
        }
        return [
            'scope' => $scope,
            'fields' => $fields,
            'exprHash' => $this->hashUnresolved($scope, $fields),
        ];
    }

    /**
     * sha256 of the canonical string: scope + '\n' + sorted field=expression
     * lines. Mirrors the TS-side exprHash() byte-for-byte.
     *
     * @param list<array{field: string, expression: string}> $fields
     */
    private function hashUnresolved(string $scope, array $fields): string
    {
        $sorted = $fields;
        usort($sorted, fn ($a, $b) => strcmp($a['field'], $b['field']));
        $canonical = $scope . "\n";
        foreach ($sorted as $f) {
            $canonical .= $f['field'] . '=' . $f['expression'] . "\n";
        }
        return hash('sha256', $canonical);
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
            $failed = [];
            foreach (($p['bind'] ?? []) as $field => $b) {
                $i = $b['arg'];
                $argNode = $args[$i] ?? null;
                $v = $this->readLiteral($argNode, $b['type']);
                $optional = $b['optional'] ?? false;
                $isWild = is_string($v) && str_contains($v, '{*}');
                if (($v === null || $isWild) && !$optional) {
                    $resolved = false;
                    $failed[] = ['field' => $field, 'node' => $argNode];
                }
                if ($v !== null) $payload[$field] = $v;
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
            if (($p['transform'] ?? null) === 'block-render') {
                $this->emitBlockRenderFact($n, $payload, $name);
                return;
            }
            if (($p['transform'] ?? null) === 'localize-data') {
                $this->emitLocalizeFact($n, $payload);
                return;
            }
            if (($p['transform'] ?? null) === 'wp-ajax-callback') {
                $action = $payload['action'] ?? null;
                if (!is_string($action) || $action === '' || str_contains($action, '{*}')) return;
                $symbol = 'wp_ajax_' . str_replace('-', '_', $action);
                $this->facts[] = [
                    'kind' => 'symbol-use',
                    'resolved' => true,
                    'location' => $this->loc($n),
                    'anchors' => [['key' => 'php-symbol:' . $symbol, 'role' => 'subject']],
                    'payload' => ['kind' => 'symbol-use', 'name' => $symbol],
                ];
                return;
            }
            if (($p['transform'] ?? null) === 'php-binary-script') {
                $this->emitPhpBinaryScript($n);
                return;
            }
            // Fan-out (PHP dynamic-registration unrolling): inside an
            // enclosing foreach loop or in_array(...) membership guard that
            // enumerates an array literal, a string-typed bound field whose
            // argument is built from the enumerated variable expands into one
            // fully-resolved fact per value — instead of one {*} skeleton
            // fact. Only the plain-anchor path fans out; transform patterns
            // have already returned above. Guarded on a non-empty enumeration
            // frame so call sites outside any unroll context are byte-for-byte
            // unchanged. Fan-out targets the FIRST expandable string-typed
            // bind field and then returns; every WP hook pattern binds exactly
            // one string field, so a pattern binding two would need this loop
            // restructured.
            $inEnum = false;
            foreach ($this->enumStack as $enumFrame) {
                if ($enumFrame !== []) { $inEnum = true; break; }
            }
            if ($inEnum) {
                $fanTpl = is_array($p['anchor'] ?? null) ? ($p['anchor']['template'] ?? '') : null;
                $fanRole = is_array($p['anchor'] ?? null) ? ($p['anchor']['role'] ?? 'subject') : 'subject';
                foreach (($p['bind'] ?? []) as $field => $b) {
                    if (($b['type'] ?? null) !== 'string') continue;
                    $expanded = $this->expandSkeleton($args[$b['arg']] ?? null);
                    if ($expanded === null || $expanded === []) continue;
                    foreach ($expanded as $value) {
                        $fanPayload = $payload;
                        $fanPayload[$field] = $value;
                        $fanAnchors = [];
                        if ($fanTpl !== null) {
                            $key = $this->renderAnchorKey($fanTpl, $fanPayload);
                            if ($key !== null) {
                                $fanAnchors[] = ['key' => $key, 'role' => $fanRole];
                            }
                        }
                        $this->facts[] = [
                            'kind' => $p['emit'],
                            'resolved' => true,
                            'location' => $this->loc($n),
                            'anchors' => $fanAnchors,
                            'payload' => $fanPayload,
                        ];
                    }
                    return;
                }
            }
            $anchors = [];
            $anchorRule = $p['anchor'] ?? null;
            if (is_array($anchorRule)) {
                $key = $this->renderAnchorKey($anchorRule['template'] ?? '', $payload);
                if ($key !== null) $anchors[] = ['key' => $key, 'role' => $anchorRule['role'] ?? 'subject'];
                else $resolved = false;
            }
            if (($p['emit'] ?? null) === 'php-include') {
                $scope = $this->currentScope();
                if ($scope !== '(file)') {
                    $anchors[] = ['key' => 'php-symbol:' . $scope, 'role' => 'target'];
                }
            }
            // Phase 0: stamp the partial-fact resolution context onto an
            // unresolved fact. Additive metadata only.
            if (!$resolved && $failed !== []) {
                $payload['unresolved'] = $this->buildUnresolvedBlock($failed);
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
            $args = $this->extractArgs($n);
            $failed = [];
            if (!is_string($namespace)) $failed[] = ['field' => 'namespace', 'node' => $args[0] ?? null];
            if (!is_string($route)) $failed[] = ['field' => 'route', 'node' => $args[1] ?? null];
            $payload = array_merge($payload, ['kind' => 'rest-endpoint']);
            $payload['unresolved'] = $this->buildUnresolvedBlock($failed);
            $this->facts[] = [
                'kind' => 'rest-endpoint',
                'resolved' => false,
                'location' => $this->loc($n),
                'anchors' => [],
                'payload' => $payload,
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
        // properties so the cross-file resolver knows what to fill. The shared
        // UnresolvedBlock carries the enclosing scope + per-property $this->
        // expressions + a stable hash.
        $unresolved = null;
        if ($skeletonWild && $this->unresolvedThisProps !== []) {
            $scope = $this->currentScope();
            $fields = [];
            foreach (array_values(array_unique($this->unresolvedThisProps)) as $prop) {
                $fields[] = ['field' => $prop, 'expression' => '$this->' . $prop];
            }
            $unresolved = [
                'scope'    => $scope,
                'fields'   => $fields,
                'exprHash' => $this->hashUnresolved($scope, $fields),
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
        // Phase 0: stamp the partial-fact resolution context when unresolved.
        if (!($handleResolved && $jsModuleEmitted)) {
            $failed = [];
            if (!$handleResolved) $failed[] = ['field' => 'handle', 'node' => $args[0] ?? null];
            if (!$jsModuleEmitted) $failed[] = ['field' => 'src', 'node' => $args[1] ?? null];
            $payload['unresolved'] = $this->buildUnresolvedBlock($failed);
        }
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
     * Emit a script-localize fact. Beyond the handle (already bound into
     * $payload), capture arg 1 (the JS object name) and arg 2 (the data
     * array) so the JS-side localize channel can resolve `<object>.<key>`.
     * resolved is true only when both the handle and the object name are
     * statically known — without the object name the fact is not actionable.
     *
     * @param array<string, mixed> $payload
     */
    private function emitLocalizeFact(Node $n, array $payload): void
    {
        $args = $this->extractArgs($n);
        $objName = ($args[1] ?? null) instanceof Node\Scalar\String_
            ? $args[1]->value : null;
        $data = ($args[2] ?? null) instanceof Node\Expr\Array_
            ? $this->readAssocStringArray($args[2]) : [];

        // Handle is always a string: a dynamic/missing arg 0 degrades to the
        // {*} skeleton (mirrors the sibling emit*Fact methods), never null.
        $handle = $payload['handle'] ?? null;
        if (!is_string($handle) || $handle === '') $handle = '{*}';
        $resolved = !str_contains($handle, '{*}') && $objName !== null;

        $outPayload = ['kind' => 'script-localize', 'handle' => $handle];
        if ($objName !== null) $outPayload['objectName'] = $objName;
        if ($data !== []) $outPayload['data'] = $data;

        $this->facts[] = [
            'kind' => 'script-localize',
            'resolved' => $resolved,
            'location' => $this->loc($n),
            'anchors' => [['key' => 'script-handle:' . $handle, 'role' => 'subject']],
            'payload' => $outPayload,
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
     * Side-effect: when arg 5 (callback) is a literal string or a known
     * `array($this, 'method')` / `array(Class::class, 'method')` pair, emit a
     * sibling `symbol-use` fact so the derive `symbol-call` bridge carries the
     * edge from the menu-registration file to the callback's defining file.
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
        $outPayload = [
            'kind' => 'admin-page-register',
            'slug' => $slug,
            'fn' => $fn,
        ];
        // Phase 0: stamp the partial-fact resolution context when the slug
        // skeleton still carries a {*} wildcard.
        if (!$resolved) {
            $args = $this->extractArgs($n);
            $slugArg = $fn === 'add_submenu_page' ? 5 : 4;
            $outPayload['unresolved'] = $this->buildUnresolvedBlock(
                [['field' => 'slug', 'node' => $args[$slugArg] ?? null]],
            );
        }
        $this->facts[] = [
            'kind' => 'admin-page-register',
            'resolved' => $resolved,
            'location' => $this->loc($n),
            'anchors' => [['key' => 'wp-admin-page:' . $slug, 'role' => 'subject']],
            'payload' => $outPayload,
        ];

        $args = $this->extractArgs($n);
        $cb = $this->adminPageCallback($args[5] ?? null);
        if ($cb !== null) {
            // Anchor at php-symbol:<name> role 'subject' so the derive
            // symbol-call bridge (which scans subjectsByAnchor's complement
            // targetsByAnchor) joins this use to the symbol-def in the
            // callback's defining file — the second hop of the e2e edge.
            // For class-method callbacks the class context produces the FQN
            // shape that matches factSymbolDef's anchor for class methods
            // (`<Class>::<method>`); top-level function callbacks stay bare.
            $anchorName = $cb['class'] !== null ? $cb['class'] . '::' . $cb['name'] : $cb['name'];
            $this->facts[] = [
                'kind' => 'symbol-use',
                'resolved' => true,
                'location' => $this->loc($n),
                'anchors' => [['key' => 'php-symbol:' . $anchorName, 'role' => 'subject']],
                'payload' => [
                    'kind' => 'symbol-use',
                    'name' => $anchorName,
                ],
            ];
        }
    }

    /**
     * Classify a WP admin-page-register callback argument and return
     * `['name' => method, 'class' => ?Fqn]`, or null if the argument shape is
     * not one the derive bridge can follow.
     *
     *   - `'render_function'`               → ['name' => 'render_function', 'class' => null]
     *   - `array( $this, 'method' )`        → ['name' => 'method', 'class' => <enclosing class FQN>]
     *   - `array( Foo::class, 'method' )`   → ['name' => 'method', 'class' => 'Foo' (resolved)]
     *   - `array( 'Foo', 'method' )`        → ['name' => 'method', 'class' => 'Foo']
     *   - anything else (closure, variable, expression, new Foo()) → null
     *
     * @return array{name: string, class: ?string}|null
     */
    private function adminPageCallback(?Node $node): ?array
    {
        if ($node === null) return null;
        if ($node instanceof Node\Scalar\String_) {
            $v = $node->value;
            return $v !== '' ? ['name' => $v, 'class' => null] : null;
        }
        if (!($node instanceof Node\Expr\Array_)) return null;
        $items = $node->items;
        if (count($items) !== 2 || $items[0] === null || $items[1] === null) return null;
        $second = $items[1]->value;
        if (!($second instanceof Node\Scalar\String_) || $second->value === '') return null;
        $method = $second->value;
        $first = $items[0]->value;

        // array($this, 'method') — class is the enclosing class.
        if ($first instanceof Node\Expr\Variable && $first->name === 'this') {
            $class = end($this->classStack);
            if ($class === false || $class === '') return null;
            return ['name' => $method, 'class' => $class];
        }
        // array(Foo::class, 'method').
        if ($first instanceof Node\Expr\ClassConstFetch
            && $first->class instanceof Node\Name
            && $first->name instanceof Node\Identifier
            && strtolower($first->name->name) === 'class') {
            $class = $this->resolveClassName($first->class);
            if ($class === '') return null;
            return ['name' => $method, 'class' => $class];
        }
        // array('Foo', 'method').
        if ($first instanceof Node\Scalar\String_ && $first->value !== '') {
            return ['name' => $method, 'class' => $first->value];
        }
        return null;
    }

    /**
     * Emit a block-render fact for register_block_type /
     * register_block_type_from_metadata. The block name (arg 0) is bound into
     * $payload['name']: a literal ('core/foo'), a skeleton ('{*}'), or absent.
     * When the name is unresolved, H6 applies the WordPress-core naming
     * convention: a render_callback literal of shape render_block_core_<slug>
     * names block core/<slug> (callback underscores become slug hyphens). A
     * non-convention callback degrades to an unresolved fact — never a guess.
     *
     * @param array<string, mixed> $payload
     */
    private function emitBlockRenderFact(Node $n, array $payload, ?string $fnName): void
    {
        // register_block_type_from_metadata's arg 0 is a metadata directory
        // path, never a block name — ignore the bound value and rely solely on
        // the render_callback convention. register_block_type's arg 0 IS the
        // block name, but only when it is a genuine string literal: a
        // __DIR__ / concat skeleton also reads as a non-empty string yet names
        // a directory, not a block, so it must fall through to the dir capture.
        $args = $this->extractArgs($n);
        $arg0IsStringLiteral = ($args[0] ?? null) instanceof Node\Scalar\String_;
        $name = ($fnName === 'register_block_type_from_metadata' || !$arg0IsStringLiteral)
            ? null
            : ($payload['name'] ?? null);
        $resolved = is_string($name) && $name !== '' && !str_contains($name, '{*}');

        if (!$resolved) {
            $slug = $this->blockSlugFromRenderCallback($n);
            if ($slug !== null) {
                $name = 'core/' . str_replace('_', '-', $slug);
                $resolved = true;
            }
        }

        $anchors = [];
        if (is_string($name) && $name !== '' && !str_contains($name, '{*}')) {
            $anchors[] = ['key' => 'block:' . $name, 'role' => 'subject'];
        }
        $outPayload = ['kind' => 'block-render'];
        if (is_string($name) && $name !== '') $outPayload['name'] = $name;

        // The block is still unnamed: arg 0 is (or may be) a directory path.
        // Capture its resolved skeleton so the build-zone block.json reader can
        // read <dir>/block.json. Only a clean, non-wildcard path is useful.
        if (!$resolved) {
            $dir = $this->readStringSkeleton($args[0] ?? null);
            if (is_string($dir) && $dir !== '' && !str_contains($dir, '{*}')) {
                $outPayload['dir'] = $this->normalizeIncludePath($dir);
            }
        }

        // Phase 0: stamp the partial-fact resolution context when the block
        // name could not be resolved (arg 0 is the unresolved expression).
        if (!$resolved) {
            $outPayload['unresolved'] = $this->buildUnresolvedBlock(
                [['field' => 'name', 'node' => $args[0] ?? null]],
            );
        }

        $this->facts[] = [
            'kind' => 'block-render',
            'resolved' => $resolved,
            'location' => $this->loc($n),
            'anchors' => $anchors,
            'payload' => $outPayload,
        ];
    }

    /**
     * Scan a register_block_type* call's options-array argument for a
     * 'render_callback' string item matching the render_block_core_<slug>
     * convention; return <slug> (underscore form) or null. Narrow: only a
     * plain string literal of the exact core convention shape matches — a
     * closure / array-callable / variable yields null.
     */
    private function blockSlugFromRenderCallback(Node $n): ?string
    {
        $args = $this->extractArgs($n);
        // The options array is the last Array_ argument.
        $arr = null;
        foreach ($args as $a) {
            if ($a instanceof Node\Expr\Array_) $arr = $a;
        }
        if ($arr === null) return null;
        foreach ($arr->items as $item) {
            if (!$item instanceof Node\ArrayItem) continue;
            if (!$item->key instanceof Node\Scalar\String_) continue;
            if ($item->key->value !== 'render_callback') continue;
            if (!$item->value instanceof Node\Scalar\String_) return null;
            if (preg_match('/^render_block_core_([a-z0-9_]+)$/', $item->value->value, $m) === 1) {
                return $m[1];
            }
            return null;
        }
        return null;
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
            return $this->restMethodsFromValue($item->value);
        }
        return [];
    }

    /** @return list<string> */
    private function restMethodsFromValue(Node $val): array
    {
        if ($val instanceof Node\Scalar\String_) {
            return $this->splitMethods($val->value);
        }
        if ($val instanceof Node\Expr\ClassConstFetch) {
            $raw = $this->wpRestServerConstantValue($val);
            return $raw === null ? [] : $this->splitMethods($raw);
        }
        if ($val instanceof Node\Expr\Array_) {
            $out = [];
            foreach ($val->items as $m) {
                if (!($m instanceof Node\ArrayItem)) continue;
                $out = array_merge($out, $this->restMethodsFromValue($m->value));
            }
            return $out;
        }
        return [];
    }

    // WP_REST_Server::<CONST> maps to the same HTTP-method strings WordPress core
    // defines on the class. Hardcoded because WP_REST_Server is core, not project
    // code, so the project-class-const index never sees these values.
    private function wpRestServerConstantValue(Node\Expr\ClassConstFetch $node): ?string
    {
        if (!$node->class instanceof Node\Name) return null;
        if (!$node->name instanceof Node\Identifier) return null;
        $cls = ltrim($node->class->toString(), '\\');
        if (strtolower($cls) !== 'wp_rest_server') return null;
        static $map = [
            'READABLE'   => 'GET',
            'CREATABLE'  => 'POST',
            'EDITABLE'   => 'POST, PUT, PATCH',
            'DELETABLE'  => 'DELETE',
            'ALLMETHODS' => 'GET, POST, PUT, PATCH, DELETE',
        ];
        $const = strtoupper($node->name->name);
        return $map[$const] ?? null;
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
        if ($n instanceof Node\Expr\FuncCall || $n instanceof Node\Expr\MethodCall || $n instanceof Node\Expr\StaticCall || $n instanceof Node\Expr\New_) {
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
                    // An interpolated part — recurse so a resolvable local
                    // variable (H1) or $this->prop is substituted; an
                    // unresolvable part falls back to the {*} skeleton.
                    $out .= $this->readStringSkeleton($part) ?? '{*}';
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
        if ($node instanceof Node\Expr\FuncCall
            && $node->name instanceof Node\Name
            && strtolower($node->name->toString()) === 'dirname') {
            $base = $this->readStringSkeleton($node->args[0]->value ?? null);
            if ($base === null || str_contains($base, '{*}')) return null;
            $levelsNode = $node->args[1]->value ?? null;
            $levels = $levelsNode instanceof Node\Scalar\LNumber ? $levelsNode->value : 1;
            if ($levels < 1) return null;
            while ($levels-- > 0) $base = dirname($base);
            return $base === '.' ? '' : $base;
        }
        if ($node instanceof Node\Scalar\MagicConst\Function_) {
            // PHP `__FUNCTION__` is the enclosing function/method name (empty
            // at file scope). Scope-stack entries are "name@line".
            $scope = end($this->scopeStack);
            if ($scope === false) return '';
            $at = strrpos($scope, '@');
            return $at === false ? $scope : substr($scope, 0, $at);
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
        if ($node instanceof Node\Expr\Variable && is_string($node->name)) {
            // H1 — depth-1 intra-function local-variable resolution. The
            // $localVars table holds only top-statement-level literal
            // assignments within the enclosing function/method. A free or
            // poisoned variable is a miss → null. The caller drops the anchor
            // (bare $var) or skeletonizes the part to {*} (encapsed/concat).
            // Returning a bare '{*}' here would be wrong: every dynamic
            // do_action($x) / do_shortcode($x) would then share the single
            // anchor hook:{*} / shortcode:{*}, and the bridge would pair every
            // dynamic fire with every dynamic listener — a false-edge blowup.
            $scope = end($this->scopeStack);
            if ($scope !== false && isset($this->localVars[$scope][$node->name])) {
                return $this->localVars[$scope][$node->name];
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
     * Return the current wrapperIndex (for reset-state preservation).
     * @return array<string, list<array<string, mixed>>>
     */
    public function getWrapperIndex(): array
    {
        return $this->wrapperIndex;
    }

    /**
     * Flatten wrapperIndex entries into a list suitable for persistence.
     * Each entry carries wrapperName, wraps, defFile, defStartLine, defEndLine,
     * argSpecsJson (JSON-encoded), and source ('auto'|'config').
     *
     * @return list<array<string, mixed>>
     */
    public function dumpWrapperIndexForPersistence(): array
    {
        $out = [];
        foreach ($this->wrapperIndex as $wrapperName => $entries) {
            foreach ($entries as $entry) {
                $out[] = [
                    'wrapperName'  => $wrapperName,
                    'wraps'        => $entry['wraps'],
                    'defFile'      => $entry['defFile'],
                    'defStartLine' => $entry['defStartLine'],
                    'defEndLine'   => $entry['defEndLine'],
                    'argSpecsJson' => json_encode($entry['argSpecs']),
                    'source'       => $entry['source'],
                ];
            }
        }
        return $out;
    }

    /**
     * Dump this worker's source='auto' wrapper entries in full in-memory shape
     * for cross-worker merging. Config entries are excluded — they are seeded
     * identically on every worker via register-patterns.
     *
     * @return list<array<string, mixed>>
     */
    public function dumpWrapperIndexForMerge(): array
    {
        $out = [];
        foreach ($this->wrapperIndex as $wrapperName => $entries) {
            foreach ($entries as $entry) {
                if (($entry['source'] ?? 'auto') !== 'auto') continue;
                $out[] = [
                    'wrapperName'  => $wrapperName,
                    'wraps'        => $entry['wraps'],
                    'defFile'      => $entry['defFile'],
                    'defStartLine' => $entry['defStartLine'],
                    'defEndLine'   => $entry['defEndLine'],
                    'argSpecs'     => $entry['argSpecs'],
                    'source'       => 'auto',
                    'class'        => $entry['class'] ?? null,
                    'kind'         => $entry['kind'] ?? 'function',
                ];
            }
        }
        return $out;
    }

    /**
     * Merge auto wrapper entries discovered on other workers into this index.
     * An entry is skipped when this worker already holds one with the same
     * (defFile, defStartLine, kind) — so a worker silently ignores its own
     * entries echoed back in the broadcast. Returns the count added.
     *
     * @param list<mixed> $entries  JSON-decoded entries from dumpWrapperIndexForMerge.
     */
    public function mergeWrapperIndexEntries(array $entries): int
    {
        $added = 0;
        foreach ($entries as $e) {
            if (!is_array($e)) continue;
            $name = $e['wrapperName'] ?? null;
            if (!is_string($name) || $name === '') continue;
            $defFile = $e['defFile'] ?? null;
            $defStartLine = $e['defStartLine'] ?? null;
            $kind = $e['kind'] ?? 'function';
            $dup = false;
            foreach ($this->wrapperIndex[$name] ?? [] as $existing) {
                if (($existing['defFile'] ?? null) === $defFile
                    && ($existing['defStartLine'] ?? null) === $defStartLine
                    && ($existing['kind'] ?? 'function') === $kind) {
                    $dup = true;
                    break;
                }
            }
            if ($dup) continue;
            $this->wrapperIndex[$name][] = [
                'wraps'        => $e['wraps'] ?? '',
                'defFile'      => $defFile,
                'defStartLine' => $defStartLine,
                'defEndLine'   => $e['defEndLine'] ?? 0,
                'argSpecs'     => is_array($e['argSpecs'] ?? null) ? $e['argSpecs'] : [],
                'source'       => 'auto',
                'class'        => $e['class'] ?? null,
                'kind'         => $kind,
            ];
            $added++;
        }
        return $added;
    }

    /**
     * Directly set the wrapperIndex (used to restore config-source entries after reset-state).
     * @param array<string, list<array<string, mixed>>> $index
     */
    public function setWrapperIndex(array $index): void
    {
        $this->wrapperIndex = $index;
    }

    public function setWrapperIndexComplete(bool $complete): void
    {
        $this->wrapperIndexComplete = $complete;
    }

    /**
     * Return true when the wrapperIndex already has at least one config-source
     * entry for $name. Used by buildWrapperIndex to let config win on collision.
     */
    private function hasConfigWrapper(string $name): bool
    {
        foreach ($this->wrapperIndex[$name] ?? [] as $entry) {
            if (($entry['source'] ?? 'auto') === 'config') return true;
        }
        return false;
    }

    /**
     * Reset all per-file state. Does NOT reset $wrapperIndex, $deferredWrapperCalls,
     * $earlyFlushedFacts, or $patternCallees — those persist across files for
     * cross-file synthesis.
     */
    public function resetForFile(string $file, ?string $relFile, string $code): void
    {
        $this->file = $file;
        $this->relFile = $relFile ?? $file;
        $this->code = $code;
        $this->facts = [];
        $this->namespace = null;
        $this->useAliases = [];
        $this->classStack = [];
        $this->classIsPhpUnit = false;
        $this->defines = [];
        $this->classConsts = [];
        $this->classProps = [];
        $this->localVars = [];
        $this->scopeStack = [];
        $this->unresolvedThisProps = [];
        $this->localArrays = [];
        $this->enumStack = [];
        $this->wrapperScopes = [];
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
        $this->localVars = [];
        // NOTE: $wrapperIndex and $deferredWrapperCalls are NOT reset here —
        // they persist across files for cross-file synthesis.
        $this->wrapperScopes = [];
        $traverser = new NodeTraverser();
        $defines = &$this->defines;
        $classConsts = &$this->classConsts;
        $classProps = &$this->classProps;
        $localVars = &$this->localVars;
        $finder = new class($defines, $classConsts, $classProps, $localVars) extends NodeVisitorAbstract {
            private ?string $ns = null;
            /** @var list<string> */
            private array $stack = [];
            /** Whether the walk is currently inside a class-method body. */
            private bool $inMethod = false;
            /** Nesting depth inside if/loop/closure/etc. within the current method. */
            private int $nesting = 0;
            /**
             * Scope keys (<name>@<startLine>) of the enclosing function/method
             * chain — H1's local-variable scope. A closure does NOT open a
             * scope frame; its assignments sit at nesting > 0 of the enclosing
             * function and are excluded by the nesting guard.
             * @var list<string>
             */
            private array $scopeStack = [];
            /**
             * Per-scope local-variable assignment ambiguity flags (H1). A
             * variable that received two differing literals is poisoned and its
             * $localVars entry deleted, so the fetch site falls back to {*}.
             * @var array<string, array<string, true>>
             */
            private array $localVarsAmbiguous = [];
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
             * @param array<string, array<string, string>> $localVars
             */
            public function __construct(
                private array &$defines,
                private array &$classConsts,
                private array &$classProps,
                private array &$localVars,
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
                    $this->scopeStack[] = $node->name->name . '@' . ($node->getStartLine() ?: 0);
                    return;
                }
                if ($node instanceof Node\Stmt\Function_) {
                    // Free functions open a local-variable scope too (H1).
                    // inMethod gates the nesting counter; reuse it as the
                    // generic "inside a function/method body" flag.
                    $this->inMethod = true;
                    $this->nesting = 0;
                    $this->scopeStack[] = $node->name->name . '@' . ($node->getStartLine() ?: 0);
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
                // H1 — top-statement-level $var = <literal> within a
                // function/method body. The nesting guard excludes branch /
                // loop / closure assignments; recordLocalVar handles ambiguity.
                if ($node instanceof Node\Expr\Assign
                    && $this->inMethod
                    && $this->nesting === 0
                    && $node->var instanceof Node\Expr\Variable
                    && is_string($node->var->name)
                    && $node->var->name !== 'this') {
                    $scope = end($this->scopeStack);
                    if ($scope !== false) {
                        $this->recordLocalVar($scope, $node->var->name, $node->expr);
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
                if ($node instanceof Node\Stmt\ClassLike && $node->name !== null) array_pop($this->stack);
                if ($node instanceof Node\Stmt\ClassMethod || $node instanceof Node\Stmt\Function_) {
                    $this->inMethod = false;
                    $this->nesting = 0;
                    array_pop($this->scopeStack);
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

            /**
             * Record a top-level $var = <rhs> assignment for H1, honoring
             * ambiguity: two differing literals poison the variable (entry
             * deleted → readStringSkeleton falls back to {*}); the same literal
             * twice is idempotent.
             */
            private function recordLocalVar(string $scope, string $var, Node $rhs): void
            {
                if (isset($this->localVarsAmbiguous[$scope][$var])) return;
                $literal = $this->readPrePassLiteral($rhs);
                if ($literal === null) return;
                $existing = $this->localVars[$scope][$var] ?? null;
                if ($existing !== null && $existing !== $literal) {
                    $this->localVarsAmbiguous[$scope][$var] = true;
                    unset($this->localVars[$scope][$var]);
                    return;
                }
                $this->localVars[$scope][$var] = $literal;
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
        if (!$this->wrapperIndexComplete) {
            // Phase-1 prepass and direct-worker (single-pass) builds populate
            // the index here. In phase-2 with a complete index seeded via
            // merge, skipping avoids appending duplicate auto entries.
            $this->buildWrapperIndex($ast);
        }
    }

    /**
     * Phase-1 entry point. The AST has already been parsed by the caller; this
     * method runs ONLY buildWrapperIndex, accumulating $wrapperIndex entries
     * with no defines/consts micro-pass, no main traverse, and no fact
     * emission. The caller is responsible for invoking resetForFile() first so
     * $this->file is set (defFile is derived from it).
     *
     * @param array<int, Node> $ast
     */
    public function buildWrapperIndexOnly(array $ast): void
    {
        $this->buildWrapperIndex($ast);
    }

    /**
     * Phase-2 helper. With wrapperIndexComplete=true buildWrapperIndex is
     * skipped, so wrapperScopes — which the main traverse uses to suppress a
     * wrapper definition's own body from emitting facts — must be seeded from
     * the complete index instead. Scope-key shape mirrors tryIndexWrapper:
     * "<name>@<defStartLine>". Only entries whose defFile equals the current
     * file matter for body suppression.
     */
    public function populateWrapperScopesFromCompleteIndex(): void
    {
        foreach ($this->wrapperIndex as $name => $entries) {
            foreach ($entries as $e) {
                if (($e['defFile'] ?? null) !== $this->file) continue;
                $startLine = $e['defStartLine'] ?? 0;
                $this->wrapperScopes[$name . '@' . $startLine] = true;
            }
        }
    }

    // Note: wrapperIndex keys are unqualified names. Calls using a fully-qualified
    // name (e.g. \MyPlugin\register_my_route()) won't synthesize. Out of scope for v1.

    /**
     * Second micro-pass: scan top-level function declarations AND class-method
     * declarations whose body directly calls a WP_PHP_PATTERNS callee with
     * literal or param-fed args. All fully-indexable wrappers are indexed;
     * in-body suppression via $wrapperScopes prevents double emission without
     * a separate call-site scan. Class methods are tagged with their owning
     * class so call-site lookup can filter by class (for $this->m() and
     * Class::m()); $instance->m() callers broadcast over all classes.
     *
     * @param array<int, Node> $ast
     */
    private function buildWrapperIndex(array $ast): void
    {
        foreach ($ast as $stmt) {
            if ($stmt instanceof Node\Stmt\Function_) {
                $this->tryIndexWrapper($stmt, null);
                continue;
            }
            if ($stmt instanceof Node\Stmt\Namespace_) {
                // Class declarations may sit inside a namespace block; recurse
                // one level to pick them up. Top-level Function_ inside a
                // namespace is handled by the outer loop iteration when the
                // parser yields the namespace's child statements directly —
                // but PHP-Parser keeps them under Namespace_->stmts, so we
                // also recurse for functions here.
                foreach ($stmt->stmts as $inner) {
                    if ($inner instanceof Node\Stmt\Function_) {
                        $this->tryIndexWrapper($inner, null);
                        continue;
                    }
                    if ($inner instanceof Node\Stmt\Class_ && $inner->name !== null) {
                        $className = $stmt->name !== null
                            ? $stmt->name->toString() . '\\' . $inner->name->name
                            : $inner->name->name;
                        foreach ($inner->stmts as $member) {
                            if ($member instanceof Node\Stmt\ClassMethod) {
                                $this->tryIndexWrapper($member, $className);
                            }
                        }
                    }
                }
                continue;
            }
            if ($stmt instanceof Node\Stmt\Class_ && $stmt->name !== null) {
                $className = $stmt->name->name;
                foreach ($stmt->stmts as $member) {
                    if ($member instanceof Node\Stmt\ClassMethod) {
                        $this->tryIndexWrapper($member, $className);
                    }
                }
            }
        }
    }

    /**
     * Index a single function-like as a wrapper if its body wraps a pattern
     * callee with at least one parameter-fed arg. $owningClass is null for
     * top-level functions and the (possibly namespaced) class name for
     * class methods.
     */
    private function tryIndexWrapper(Node\FunctionLike $fn, ?string $owningClass): void
    {
        $callees = $this->getPatternCallees();
        if (!($fn instanceof Node\Stmt\Function_) && !($fn instanceof Node\Stmt\ClassMethod)) {
            return; // Closures / arrow functions are not wrappers.
        }
        if ($fn->name === null) return;
        // Build a one-hop local-var expression map for the function body.
        // Only top-level (depth-1) assignments where the RHS is not itself
        // a simple variable are included. Used by buildArgSpecs to resolve
        // aliases like $opts = array_merge($defaults, $extras).
        $localVarExprs = [];
        foreach ($fn->stmts ?? [] as $bodyStmt) {
            if ($bodyStmt instanceof Node\Stmt\Expression
                && $bodyStmt->expr instanceof Node\Expr\Assign
                && $bodyStmt->expr->var instanceof Node\Expr\Variable
                && is_string($bodyStmt->expr->var->name)
                && !($bodyStmt->expr->expr instanceof Node\Expr\Variable)) {
                $localVarExprs[$bodyStmt->expr->var->name] = $bodyStmt->expr->expr;
            }
        }
        foreach ($this->collectCandidatePatternCalls($fn) as [$call, $closureUses, $closureLocalVarExprs]) {
            $wrappedName = $call->name instanceof Node\Name ? $call->name->toString() : null;
            if ($wrappedName === null || !isset($callees[$wrappedName])) continue;
            $innerArgs = [];
            foreach ($call->args as $a) {
                if ($a instanceof Node\Arg) $innerArgs[] = $a;
            }
            $effectiveLocalVarExprs = $closureLocalVarExprs !== [] ? $closureLocalVarExprs : $localVarExprs;
            $argSpecs = $this->buildArgSpecs($innerArgs, $fn->params, $closureUses, $effectiveLocalVarExprs);
            if ($argSpecs === null) continue;
            $hasParam = false;
            foreach ($argSpecs as $spec) {
                if ($spec['kind'] === 'param') { $hasParam = true; break; }
            }
            if (!$hasParam) continue;
            $name = $fn->name->name;
            $scopeKey = $name . '@' . ($fn->getStartLine() ?: 0);
            if ($this->hasConfigWrapper($name)) {
                $this->wrapperScopes[$scopeKey] = true;
            } else {
                $kind = $owningClass === null ? 'function' : 'method';
                $this->wrapperIndex[$name][] = [
                    'wraps'        => $wrappedName,
                    'defFile'      => $this->file,
                    'defStartLine' => $fn->getStartLine(),
                    'defEndLine'   => $fn->getEndLine(),
                    'argSpecs'     => $argSpecs,
                    'source'       => 'auto',
                    'class'        => $owningClass,
                    'kind'         => $kind,
                ];
                $this->wrapperScopes[$scopeKey] = true;
            }
        }
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

    /** Source text of a node, sliced from $code by file position, or null. */
    private function nodeText(?Node $node): ?string
    {
        if ($node === null || $this->code === '') return null;
        $start = $node->getStartFilePos();
        $end = $node->getEndFilePos();
        if ($start < 0 || $end < $start) return null;
        return substr($this->code, $start, $end - $start + 1);
    }

    /**
     * String-literal element values of an array literal. Non-string elements
     * are skipped, so the result is a sound subset of the runtime array.
     *
     * @return list<string>
     */
    private function arrayLiteralStrings(Node\Expr\Array_ $arr): array
    {
        $out = [];
        foreach ($arr->items as $item) {
            if (!$item instanceof Node\ArrayItem) continue;
            if ($item->value instanceof Node\Scalar\String_) {
                $out[] = $item->value->value;
            }
        }
        return $out;
    }

    /**
     * Read a PHP associative array literal `array('k' => 'v', ...)` into a
     * key->value map, keeping only entries whose key AND value are string
     * literals. A non-string-literal value (int, expression, nested array) is
     * skipped — the result is a sound subset.
     *
     * @return array<string, string>
     */
    private function readAssocStringArray(Node\Expr\Array_ $arr): array
    {
        $out = [];
        foreach ($arr->items as $item) {
            if (!$item instanceof Node\ArrayItem) continue;
            if (!$item->key instanceof Node\Scalar\String_) continue;
            if (!$item->value instanceof Node\Scalar\String_) continue;
            $out[$item->key->value] = $item->value->value;
        }
        return $out;
    }

    /**
     * Resolve a node to a flat list of string literals when it is a statically
     * known array of strings: an array literal, a variable bound to one, or an
     * array_merge of such. Null when not resolvable.
     *
     * @return list<string>|null
     */
    private function resolveArraySource(?Node $node): ?array
    {
        if ($node === null) return null;
        if ($node instanceof Node\Expr\Array_) {
            return $this->arrayLiteralStrings($node);
        }
        if ($node instanceof Node\Expr\Variable && is_string($node->name)) {
            return $this->localArrays[$this->currentScope()][$node->name] ?? null;
        }
        if ($node instanceof Node\Expr\FuncCall
            && $node->name instanceof Node\Name
            && strtolower($node->name->toString()) === 'array_merge') {
            $out = [];
            foreach ($this->extractArgs($node) as $arg) {
                $part = $this->resolveArraySource($arg);
                if ($part === null) return null;
                foreach ($part as $s) {
                    $out[] = $s;
                }
            }
            return $out;
        }
        return null;
    }

    /**
     * Expand an expression to the full list of literal strings it can take
     * when a variable in it is bound by an enclosing foreach / in_array
     * enumeration (the $enumStack). Returns null when the node is not a clean
     * enumerable expression — the caller then falls back to the single-value
     * readStringSkeleton path. Never yields a {*} wildcard: an unresolvable
     * sub-expression collapses the whole result to null.
     *
     * @return list<string>|null
     */
    private function expandSkeleton(?Node $node): ?array
    {
        if ($node === null) return null;
        // An expression whose source text matches an active enumeration
        // binding expands to that binding's value set. Innermost frame wins.
        $text = $this->nodeText($node);
        if ($text !== null) {
            for ($i = count($this->enumStack) - 1; $i >= 0; $i--) {
                if (isset($this->enumStack[$i][$text])) {
                    return $this->enumStack[$i][$text];
                }
            }
        }
        if ($node instanceof Node\Scalar\String_) return [$node->value];
        if ($node instanceof Node\Expr\BinaryOp\Concat) {
            $left = $this->expandSkeleton($node->left);
            $right = $this->expandSkeleton($node->right);
            if ($left === null || $right === null) return null;
            $out = [];
            foreach ($left as $l) {
                foreach ($right as $r) {
                    $out[] = $l . $r;
                }
            }
            return $out;
        }
        if ($node instanceof Node\Scalar\Encapsed) {
            $acc = [''];
            foreach ($node->parts as $part) {
                if ($part instanceof Node\Scalar\EncapsedStringPart) {
                    // Literal segment — always a singleton.
                    $piece = [$part->value];
                } else {
                    $piece = $this->expandSkeleton($part);
                }
                if ($piece === null) return null;
                $next = [];
                foreach ($acc as $a) {
                    foreach ($piece as $p) {
                        $next[] = $a . $p;
                    }
                }
                $acc = $next;
            }
            return $acc;
        }
        return null;
    }

    /**
     * Search a condition expression for an in_array($needle, $haystack) call,
     * descending through binary operators (&&, ||) so a guard like
     * `! empty($x) && in_array($x, $list)` is found — the `! empty(...)` side
     * yields no match, the in_array side does. A negated in_array — an
     * exclusion guard — is deliberately NOT matched: inside its `if` body the
     * needle is NOT in the list, so binding the whitelist would be unsound.
     * Returns [needleNode, haystackNode] for the first match, or null.
     *
     * @return array{0: Node, 1: Node}|null
     */
    private function findInArrayGuard(Node $cond): ?array
    {
        if ($cond instanceof Node\Expr\FuncCall
            && $cond->name instanceof Node\Name
            && strtolower($cond->name->toString()) === 'in_array') {
            $args = $this->extractArgs($cond);
            if (isset($args[0], $args[1])) {
                return [$args[0], $args[1]];
            }
            return null;
        }
        if ($cond instanceof Node\Expr\BinaryOp) {
            return $this->findInArrayGuard($cond->left)
                ?? $this->findInArrayGuard($cond->right);
        }
        return null;
    }

    // --- Wrapper detection helpers ---

    /**
     * Build $patternCallees lazily from Patterns::$entries (WP_PHP_PATTERNS).
     * Returns a set of callee function names that are handled by the pattern engine.
     * @return array<string, true>
     */
    private function getPatternCallees(): array
    {
        if ($this->patternCallees !== null) return $this->patternCallees;
        $this->patternCallees = [];
        foreach (Patterns::$entries as $p) {
            $name = ($p['match'] ?? null)['name'] ?? null;
            if (is_string($name) && $name !== '') {
                $this->patternCallees[$name] = true;
            }
        }
        return $this->patternCallees;
    }

    private function findDirectPatternCallInStmt(Node\Stmt $stmt): ?Node\Expr\FuncCall
    {
        if ($stmt instanceof Node\Stmt\Expression && $stmt->expr instanceof Node\Expr\FuncCall) {
            return $stmt->expr;
        }
        return null;
    }

    /**
     * If $stmt is an add_action / add_filter call with a Closure argument,
     * return that Closure node; otherwise return null.
     */
    private function extractAddActionClosure(Node\Stmt $stmt): ?Node\Expr\Closure
    {
        if (!$stmt instanceof Node\Stmt\Expression) return null;
        if (!$stmt->expr instanceof Node\Expr\FuncCall) return null;
        if (!$stmt->expr->name instanceof Node\Name) return null;
        $callee = strtolower($stmt->expr->name->toString());
        if ($callee !== 'add_action' && $callee !== 'add_filter') return null;
        foreach ($stmt->expr->args as $arg) {
            if ($arg instanceof Node\Arg && $arg->value instanceof Node\Expr\Closure) {
                return $arg->value;
            }
        }
        return null;
    }

    /**
     * Collect candidate pattern-call sites from a function body.
     * Returns triples of [FuncCall, closureUses|null, closureLocalVarExprs]:
     * - Direct call at top level: closureUses is null, closureLocalVarExprs is [].
     * - Call inside an add_action/add_filter closure: closureUses is the
     *   closure's use(...) list, closureLocalVarExprs is the closure-body
     *   local-var map with snapshot (last-write-wins, RHS resolved against
     *   the map state before the current assignment).
     *
     * @param Node\Stmt\Function_|Node\Stmt\ClassMethod $fn
     * @return list<array{0: Node\Expr\FuncCall, 1: ?list<Node\Expr\ClosureUse>, 2: array<string, Node\Expr>}>
     */
    private function collectCandidatePatternCalls(Node\FunctionLike $fn): array
    {
        $out = [];
        foreach ($fn->stmts ?? [] as $stmt) {
            if ($stmt instanceof Node\Stmt\Expression && $stmt->expr instanceof Node\Expr\FuncCall) {
                $out[] = [$stmt->expr, null, []];
            }
            $closure = $this->extractAddActionClosure($stmt);
            if ($closure !== null) {
                // Build a local-var expression map for the closure body using
                // snapshot semantics: when processing statement N, the RHS is
                // resolved against the map state from statements 1..N-1 only.
                // This correctly handles self-referential re-assignments like
                // $opts = array_merge($opts, $extras) where the inner $opts
                // refers to the previous assignment.
                $closureLocalVarExprs = [];
                foreach ($closure->stmts ?? [] as $inner) {
                    if ($inner instanceof Node\Stmt\Expression
                        && $inner->expr instanceof Node\Expr\Assign
                        && $inner->expr->var instanceof Node\Expr\Variable
                        && is_string($inner->expr->var->name)) {
                        $varName = $inner->expr->var->name;
                        $rhs = $inner->expr->expr;
                        // Resolve the RHS against the current snapshot before updating.
                        $resolved = $this->resolveExprWithLocalVars($rhs, $closureLocalVarExprs);
                        // Update the map with the resolved expression (last write wins).
                        $closureLocalVarExprs[$varName] = $resolved;
                    }
                    if ($inner instanceof Node\Stmt\Expression && $inner->expr instanceof Node\Expr\FuncCall) {
                        $out[] = [$inner->expr, $closure->uses, $closureLocalVarExprs];
                    }
                }
            }
        }
        return $out;
    }

    /**
     * Resolve a single expression by substituting variable references through
     * the given local-var map (one level deep). If a variable is in the map,
     * replace it with the mapped expression; otherwise return the original node.
     * Non-variable expressions are returned as-is.
     *
     * @param array<string, Node\Expr> $localVarExprs
     */
    private function resolveExprWithLocalVars(Node\Expr $expr, array $localVarExprs): Node\Expr
    {
        if ($expr instanceof Node\Expr\Variable && is_string($expr->name)) {
            return $localVarExprs[$expr->name] ?? $expr;
        }
        // For array_merge, substitute variable args that are in the map.
        if ($expr instanceof Node\Expr\FuncCall
            && $expr->name instanceof Node\Name
            && strtolower($expr->name->toString()) === 'array_merge') {
            $newArgs = [];
            $changed = false;
            foreach ($expr->args as $arg) {
                if ($arg instanceof Node\Arg
                    && $arg->value instanceof Node\Expr\Variable
                    && is_string($arg->value->name)
                    && isset($localVarExprs[$arg->value->name])) {
                    $newArgs[] = new Node\Arg($localVarExprs[$arg->value->name]);
                    $changed = true;
                } else {
                    $newArgs[] = $arg;
                }
            }
            if ($changed) {
                $newCall = new Node\Expr\FuncCall($expr->name, $newArgs);
                return $newCall;
            }
        }
        return $expr;
    }

    /**
     * @param list<Node\Arg>                    $args
     * @param list<Node\Param>                  $params
     * @param list<Node\Expr\ClosureUse>|null   $closureUses  non-null when the
     *        inner call is inside a closure; restricts variable lookup to vars
     *        explicitly captured via use(...).
     * @param array<string, Node\Expr>          $localVars    varName => assigned expr (one-hop)
     * @return list<array<string,mixed>>|null
     */
    private function buildArgSpecs(array $args, array $params, ?array $closureUses = null, array $localVars = []): ?array
    {
        $paramIdxByName = [];
        foreach ($params as $i => $p) {
            if ($p->var instanceof Node\Expr\Variable && is_string($p->var->name)) {
                $paramIdxByName[$p->var->name] = $i;
            }
        }
        // Build the set of names captured by use(...), if we are in a closure context.
        $useNames = null;
        if ($closureUses !== null) {
            $useNames = [];
            foreach ($closureUses as $u) {
                if ($u instanceof Node\Expr\ClosureUse
                    && $u->var instanceof Node\Expr\Variable
                    && is_string($u->var->name)) {
                    $useNames[$u->var->name] = true;
                }
            }
        }
        $out = [];
        foreach ($args as $a) {
            // Named arguments (PHP 8+) are not supported; bail to avoid wrong synthesis.
            if ($a->name !== null) return null;
            $v = $a->value;
            // Resolve a same-function-body local-var alias one hop.
            if ($v instanceof Node\Expr\Variable && is_string($v->name) && isset($localVars[$v->name])) {
                $v = $localVars[$v->name];
            }
            if ($v instanceof Node\Expr\Variable && is_string($v->name)) {
                // In a closure context the variable must be explicitly captured
                // via use(...) to be a wrapper param; an untracked variable is
                // a closure-local or undefined — disqualify the whole wrapper.
                if ($useNames !== null && !isset($useNames[$v->name])) return null;
                if (isset($paramIdxByName[$v->name])) {
                    $out[] = ['kind' => 'param', 'wrapperParamIdx' => $paramIdxByName[$v->name]];
                    continue;
                }
                return null;
            }
            // Detect array_merge($defaults, $callerParam) shape.
            if ($v instanceof Node\Expr\FuncCall
                && $v->name instanceof Node\Name
                && strtolower($v->name->toString()) === 'array_merge'
                && count($v->args) === 2) {
                $first = $v->args[0]->value;
                // Resolve the first arg through localVars if it's a variable.
                if ($first instanceof Node\Expr\Variable && is_string($first->name) && isset($localVars[$first->name])) {
                    $first = $localVars[$first->name];
                }
                $second = $v->args[1]->value;
                if ($first instanceof Node\Expr\Array_
                    && $second instanceof Node\Expr\Variable
                    && is_string($second->name)
                    && isset($paramIdxByName[$second->name])) {
                    // Use partial literal reading: skip non-literal values instead of returning null.
                    $defaults = $this->readPartialLiteralArray($first);
                    $out[] = [
                        'kind' => 'merge',
                        'defaults' => $defaults,
                        'callerParamIdx' => $paramIdxByName[$second->name],
                    ];
                    continue;
                }
            }
            $lit = $this->readArgLiteralValue($v);
            if ($lit !== null) {
                $out[] = ['kind' => 'fixed', 'value' => $lit];
                continue;
            }
            return null;
        }
        return $out;
    }

    /**
     * Read an Array_ node into a mixed-value map, keeping only items whose
     * value is a literal (string/int/bool/array-of-literals). Non-literal values
     * are silently skipped. Always returns an array, never null.
     *
     * @return array<int|string, mixed>
     */
    private function readPartialLiteralArray(Node\Expr\Array_ $n): array
    {
        $out = [];
        foreach ($n->items as $item) {
            if (!$item instanceof Node\ArrayItem) continue;
            $vv = $this->readArgLiteralValue($item->value);
            if ($vv === null) continue; // skip non-literal values
            if ($item->key === null) {
                $out[] = $vv;
            } elseif ($item->key instanceof Node\Scalar\String_) {
                $out[$item->key->value] = $vv;
            }
            // Non-string-literal key with literal value: skip (rare edge case)
        }
        return $out;
    }

    private function readArgLiteralValue(Node $n): mixed
    {
        if ($n instanceof Node\Scalar\String_) return $n->value;
        if ($n instanceof Node\Scalar\LNumber || $n instanceof Node\Scalar\Int_) return $n->value;
        if ($n instanceof Node\Expr\ConstFetch) {
            $lname = strtolower($n->name->toString());
            if ($lname === 'true') return true;
            if ($lname === 'false') return false;
        }
        if ($n instanceof Node\Expr\Array_) {
            $out = [];
            foreach ($n->items as $item) {
                if (!$item instanceof Node\ArrayItem) return null;
                $vv = $this->readArgLiteralValue($item->value);
                if ($vv === null) return null;
                if ($item->key === null) { $out[] = $vv; continue; }
                if (!$item->key instanceof Node\Scalar\String_) return null;
                $out[$item->key->value] = $vv;
            }
            return $out;
        }
        return null;
    }

    /**
     * Seed the wrapperIndex from user-configured wrapper definitions (source='config').
     * The protocol uses json_decode(..., true) so wrappers arrive as assoc arrays.
     * Existing config-source entries for the same wrapper name are replaced so that
     * calling this method multiple times (e.g. after reset-state) is idempotent.
     *
     * @param list<mixed> $wrappers  Raw JSON-decoded wrapper arrays from the protocol.
     */
    public function seedConfigWrappers(array $wrappers): void
    {
        foreach ($wrappers as $w) {
            if (!is_array($w)) continue;
            $name = $w['name'] ?? null;
            if (!is_string($name) || $name === '') continue;
            $wraps = $w['wraps'] ?? null;
            if (!is_string($wraps) || $wraps === '') continue;
            $argSpecs = $this->argSpecsFromJson($w['argSpecs'] ?? []);
            // Remove existing config-source entries for this wrapper name before re-adding,
            // so repeated calls (e.g. registerPatterns called after reset-state) stay idempotent.
            if (isset($this->wrapperIndex[$name])) {
                $this->wrapperIndex[$name] = array_values(
                    array_filter($this->wrapperIndex[$name], fn($e) => ($e['source'] ?? 'auto') !== 'config')
                );
            }
            $this->wrapperIndex[$name][] = [
                'wraps'        => $wraps,
                'defFile'      => '<config>',
                'defStartLine' => 0,
                'defEndLine'   => 0,
                'argSpecs'     => $argSpecs,
                'source'       => 'config',
            ];
        }
    }

    /**
     * Convert JSON-decoded argSpecs (assoc arrays from json_decode(..., true)) to
     * the internal PHP array format.
     *
     * @param mixed $specs
     * @return list<array<string, mixed>>
     */
    private function argSpecsFromJson(mixed $specs): array
    {
        if (!is_array($specs)) return [];
        $out = [];
        foreach ($specs as $s) {
            if (!is_array($s)) continue;
            $kind = $s['kind'] ?? null;
            if ($kind === 'fixed') {
                $value = $s['value'] ?? null;
                $out[] = ['kind' => 'fixed', 'value' => $value];
            } elseif ($kind === 'param') {
                $out[] = ['kind' => 'param', 'wrapperParamIdx' => (int)($s['wrapperParamIdx'] ?? 0)];
            } elseif ($kind === 'merge') {
                $defaults = is_array($s['defaults'] ?? null) ? $s['defaults'] : [];
                $out[] = ['kind' => 'merge', 'defaults' => $defaults, 'callerParamIdx' => (int)($s['callerParamIdx'] ?? 0)];
            } elseif ($kind === 'unresolved') {
                $out[] = ['kind' => 'unresolved'];
            }
        }
        return $out;
    }

    /**
     * Serialize a call's argument list to scalar values at stub creation time,
     * avoiding live AST Node references in the deferred queue. Each arg is
     * resolved to its literal value (string, int, bool, array) or null when
     * dynamic. Scalars are tiny compared to AST Node object graphs; this
     * prevents O(N) memory growth across large codebases.
     *
     * @param array<int, Node\Arg|Node\VariadicPlaceholder> $args
     * @return list<mixed>
     */
    private function serializeArgsForDeferred(array $args): array
    {
        $out = [];
        foreach ($args as $a) {
            if (!$a instanceof Node\Arg) {
                $out[] = null;
                continue;
            }
            $out[] = $this->serializeNodeValue($a->value);
        }
        return $out;
    }

    /**
     * Resolve a single expression node to a scalar value for deferred storage.
     * Returns null when the expression is not statically resolvable.
     */
    private function serializeNodeValue(Node $node): mixed
    {
        if ($node instanceof Node\Scalar\String_) return $node->value;
        if ($node instanceof Node\Scalar\LNumber || $node instanceof Node\Scalar\Int_) return $node->value;
        if ($node instanceof Node\Expr\ConstFetch) {
            $lname = strtolower($node->name->toString());
            if ($lname === 'true') return true;
            if ($lname === 'false') return false;
            if ($lname === 'null') return null;
            // Non-boolean const — try defines table
            return $this->defines[$node->name->toString()] ?? null;
        }
        if ($node instanceof Node\Expr\Array_) {
            $out = [];
            foreach ($node->items as $item) {
                if (!$item instanceof Node\ArrayItem) return null;
                $v = $this->serializeNodeValue($item->value);
                if ($item->key === null) {
                    $out[] = $v;
                } elseif ($item->key instanceof Node\Scalar\String_) {
                    $out[$item->key->value] = $v;
                }
                // Non-string-literal key: skip
            }
            return $out;
        }
        // For string-typed args, try full readStringSkeleton resolution.
        $str = $this->readStringSkeleton($node);
        return $str; // may be null or a skeleton with {*}
    }

    /**
     * Eagerly replay deferred stubs whose wrapper was just found in the latest
     * prePass. Synthesized facts are stored in $earlyFlushedFacts (not returned),
     * so the per-file extract response stays clean. They will be emitted at
     * flush-deferred time alongside any remaining deferred stubs' results.
     *
     * This keeps the deferred queue bounded: stubs are consumed as their wrappers
     * are discovered rather than accumulating until flush-deferred. Without this,
     * large codebases (10k+ files) accumulate enough stubs to exhaust PHP memory.
     */
    public function earlyReplayAndBuffer(): void
    {
        $facts = $this->doReplayDeferred();
        foreach ($facts as $f) {
            $this->earlyFlushedFacts[] = $f;
        }
    }

    /**
     * Replay deferred wrapper calls against the current (now-complete) wrapper index.
     * Returns all synthesized facts: early-buffered ones plus any newly resolved stubs.
     * Calls whose callee is still absent from the index remain in $deferredWrapperCalls.
     *
     * @return list<array<string, mixed>>
     */
    public function replayDeferredCalls(): array
    {
        $newFacts = $this->doReplayDeferred();
        // Include early-buffered facts from per-file eager replays.
        $all = array_merge($this->earlyFlushedFacts, $newFacts);
        $this->earlyFlushedFacts = [];
        return $all;
    }

    /**
     * Internal: replay deferred stubs against the current wrapper index.
     * Removes resolved stubs from $deferredWrapperCalls. Synthesized facts are
     * spliced out of $this->facts (so they don't appear in the per-file extract
     * response) and returned for the caller to route appropriately.
     * @return list<array<string, mixed>>
     */
    private function doReplayDeferred(): array
    {
        $remaining = [];
        $newFacts = [];
        foreach ($this->deferredWrapperCalls as $stub) {
            if (!isset($this->wrapperIndex[$stub['callee']])) {
                $remaining[] = $stub;
                continue;
            }
            // Filter wrapperIndex entries by the stub's call-shape. Stubs from
            // older builds without `callKind` default to 'function' for backward
            // compatibility (function calls were the only deferred shape before
            // class-method wrappers shipped).
            $callKind = $stub['callKind'] ?? 'function';
            $lookupClass = $stub['lookupClass'] ?? null;
            $matchedEntries = [];
            foreach ($this->wrapperIndex[$stub['callee']] as $entry) {
                $entryKind = $entry['kind'] ?? 'function';
                if ($callKind === 'function') {
                    if ($entryKind !== 'function') continue;
                } else {
                    if ($entryKind !== 'method') continue;
                    if (($callKind === 'method-this' || $callKind === 'static-method')
                        && $lookupClass !== null
                        && ($entry['class'] ?? null) !== $lookupClass) continue;
                    // 'method-instance' or null lookupClass → broadcast across
                    // all method-kind entries with this name.
                }
                $matchedEntries[] = $entry;
            }
            if ($matchedEntries === []) {
                $remaining[] = $stub;
                continue;
            }
            // Temporarily swap the absolute file path so location stamps are correct.
            $savedFile = $this->file;
            $this->file = $stub['file'];
            $countBefore = count($this->facts);
            $this->synthesizeWrappedCallFromStub(
                $stub['callee'], $stub['serializedArgs'], $stub['startLine'], $stub['endLine'], $matchedEntries
            );
            // Collect the facts that were just appended and splice them out of
            // $this->facts so they don't pollute the current file's fact list.
            for ($i = $countBefore; $i < count($this->facts); $i++) {
                $newFacts[] = $this->facts[$i];
            }
            array_splice($this->facts, $countBefore);
            $this->file = $savedFile;
        }
        $this->deferredWrapperCalls = $remaining;
        return $newFacts;
    }

    /**
     * Synthesize wrapped pattern calls for each function-kind wrapperIndex
     * entry matching $wrapperName. Used for live (same-file) function calls
     * where the full AST is available. Method-kind entries are filtered out
     * — call-site shape (FuncCall vs MethodCall/StaticCall) drives which
     * entries are eligible.
     *
     * @param list<Node\Arg|Node\VariadicPlaceholder> $callerArgs
     */
    private function synthesizeWrappedCall(string $wrapperName, array $callerArgs, Node $callerCallNode): void
    {
        foreach ($this->wrapperIndex[$wrapperName] ?? [] as $entry) {
            if (($entry['kind'] ?? 'function') !== 'function') continue;
            $this->synthesizeWrappedCallForEntry($entry, $wrapperName, $callerArgs, $callerCallNode);
        }
    }

    /**
     * Live-synthesize a single wrapped call from a known wrapperIndex entry.
     * Shared by the FuncCall / MethodCall / StaticCall synthesis paths so the
     * AST construction and emit happens in one place.
     *
     * @param array<string, mixed>                          $entry
     * @param list<Node\Arg|Node\VariadicPlaceholder>       $callerArgs
     */
    private function synthesizeWrappedCallForEntry(
        array $entry,
        string $wrapperName,
        array $callerArgs,
        Node $callerCallNode
    ): void {
        $wrapsCall = $entry['wraps'];
        $filteredArgs = [];
        foreach ($callerArgs as $a) {
            if ($a instanceof Node\Arg) $filteredArgs[] = $a;
        }
        $synthesizedArgs = $this->materializeWrappedArgs($entry['argSpecs'], $filteredArgs);
        if ($synthesizedArgs === null) return;
        $synthCall = new Node\Expr\FuncCall(new Node\Name($wrapsCall), $synthesizedArgs);
        $synthCall->setAttribute('startLine', $callerCallNode->getStartLine());
        $synthCall->setAttribute('endLine', $callerCallNode->getEndLine());
        $synthCall->setAttribute('startFilePos', $callerCallNode->getAttribute('startFilePos') ?? 0);
        $synthCall->setAttribute('endFilePos', $callerCallNode->getAttribute('endFilePos') ?? 0);
        $this->emitForCallee($wrapsCall, $synthCall, [
            'resolvedBy' => 'wrapper-auto',
            'wrapperName' => $wrapperName,
            'wrapperDef' => ['file' => $entry['defFile'], 'startLine' => $entry['defStartLine']],
        ]);
    }

    /**
     * Live-synthesize for a method/static call: filter wrapperIndex entries to
     * method-kind and (when $lookupClass is non-null) to the matching owning
     * class, then synthesize for each match. When no entries match, buffer a
     * deferred stub so a later file's wrapper def can complete the synthesis.
     *
     * @param list<Node\Arg|Node\VariadicPlaceholder> $callerArgs
     */
    private function trySynthesizeMethodWrapper(
        string $name,
        array $callerArgs,
        Node $callerCallNode,
        ?string $lookupClass,
        string $callKind,
        bool $inWrapperBody
    ): void {
        $matched = false;
        foreach ($this->wrapperIndex[$name] ?? [] as $entry) {
            if (($entry['kind'] ?? 'function') !== 'method') continue;
            if ($lookupClass !== null && ($entry['class'] ?? null) !== $lookupClass) continue;
            $this->synthesizeWrappedCallForEntry($entry, $name, $callerArgs, $callerCallNode);
            $matched = true;
        }
        if ($matched) return;
        if ($this->wrapperIndexComplete) return;
        // Single-pass mode only — buffer for cross-file deferred replay,
        // mirroring the FuncCall path. Skip builtins / known pattern callees /
        // calls inside an already-classified wrapper body.
        if ($inWrapperBody) return;
        if (self::isBuiltinFunction($name)) return;
        if (isset($this->getPatternCallees()[$name])) return;
        $serializedArgs = $this->serializeArgsForDeferred($callerArgs);
        $this->deferredWrapperCalls[] = [
            'callee'    => $name,
            'serializedArgs' => $serializedArgs,
            'file'      => $this->file,
            'startLine' => $callerCallNode->getStartLine(),
            'endLine'   => $callerCallNode->getEndLine(),
            'callKind'  => $callKind,
            'lookupClass' => $lookupClass,
        ];
    }

    /**
     * Synthesize wrapped pattern calls from a deferred stub. Uses pre-resolved
     * scalar arg values (no live AST references). Reconstructs Node\Arg[] from
     * the serialized values using literalToNode().
     *
     * @param list<mixed> $serializedArgs Pre-resolved arg values from serializeArgsForDeferred().
     */
    /**
     * @param list<mixed>                       $serializedArgs
     * @param list<array<string, mixed>>|null   $entries       Pre-filtered wrapperIndex
     *        entries to synthesize against. When null, iterates ALL entries for
     *        the given $wrapperName — backward-compat for any caller that
     *        doesn't pre-filter; the new deferred-replay path always passes a
     *        filtered list.
     */
    private function synthesizeWrappedCallFromStub(
        string $wrapperName,
        array $serializedArgs,
        int $startLine,
        int $endLine,
        ?array $entries = null
    ): void
    {
        // Reconstruct Node\Arg[] from serialized scalar values.
        $callerArgs = [];
        foreach ($serializedArgs as $val) {
            $callerArgs[] = new Node\Arg($this->literalToNode($val));
        }

        $iter = $entries ?? ($this->wrapperIndex[$wrapperName] ?? []);
        foreach ($iter as $entry) {
            $wrapsCall = $entry['wraps'];
            $synthesizedArgs = $this->materializeWrappedArgs($entry['argSpecs'], $callerArgs);
            if ($synthesizedArgs === null) continue;
            $synthCall = new Node\Expr\FuncCall(new Node\Name($wrapsCall), $synthesizedArgs);
            $synthCall->setAttribute('startLine', $startLine);
            $synthCall->setAttribute('endLine', $endLine);
            $synthCall->setAttribute('startFilePos', 0);
            $synthCall->setAttribute('endFilePos', 0);
            $this->emitForCallee($wrapsCall, $synthCall, ['resolvedBy' => 'wrapper-auto', 'wrapperName' => $wrapperName, 'wrapperDef' => ['file' => $entry['defFile'], 'startLine' => $entry['defStartLine']]]);
        }
    }

    /**
     * @param list<array<string,mixed>> $argSpecs
     * @param list<Node\Arg>            $callerArgs
     * @return list<Node\Arg>|null
     */
    private function materializeWrappedArgs(array $argSpecs, array $callerArgs): ?array
    {
        // Named arguments at the call site are not supported; bail to avoid wrong synthesis.
        foreach ($callerArgs as $a) {
            if ($a->name !== null) return null;
        }
        $out = [];
        foreach ($argSpecs as $spec) {
            if ($spec['kind'] === 'fixed') {
                $out[] = new Node\Arg($this->literalToNode($spec['value']));
                continue;
            }
            if ($spec['kind'] === 'param') {
                $idx = $spec['wrapperParamIdx'];
                if (!isset($callerArgs[$idx])) return null;
                $out[] = $callerArgs[$idx];
                continue;
            }
            if ($spec['kind'] === 'merge') {
                $callerArgIdx = $spec['callerParamIdx'];
                $callerArg = $callerArgs[$callerArgIdx] ?? null;
                $callerArrayNode = ($callerArg !== null && $callerArg->value instanceof Node\Expr\Array_)
                    ? $callerArg->value : null;

                // Start with defaults as fresh AST items.
                $itemsByKey = [];        // key => Node\ArrayItem
                $orderedKeys = [];
                foreach ($spec['defaults'] as $k => $v) {
                    if (!is_string($k)) continue; // v1: keyed items only
                    $itemsByKey[$k] = new Node\ArrayItem(
                        $this->literalToNode($v),
                        new Node\Scalar\String_($k),
                    );
                    $orderedKeys[] = $k;
                }
                // Overlay caller items (caller wins for string keys). Preserves ClassConstFetch.
                if ($callerArrayNode !== null) {
                    foreach ($callerArrayNode->items as $item) {
                        if (!$item instanceof Node\ArrayItem) continue;
                        if (!$item->key instanceof Node\Scalar\String_) continue;
                        $k = $item->key->value;
                        $itemsByKey[$k] = $item;
                        if (!in_array($k, $orderedKeys, true)) $orderedKeys[] = $k;
                    }
                }
                $itemsOut = array_map(fn($k) => $itemsByKey[$k], $orderedKeys);
                $out[] = new Node\Arg(new Node\Expr\Array_($itemsOut));
                continue;
            }
        }
        return $out;
    }

    private function literalToNode(mixed $value): Node\Expr
    {
        if (is_string($value)) return new Node\Scalar\String_($value);
        if (is_int($value))    return new Node\Scalar\LNumber($value);
        if (is_bool($value))   return new Node\Expr\ConstFetch(new Node\Name($value ? 'true' : 'false'));
        if (is_array($value)) {
            $items = [];
            foreach ($value as $k => $v) {
                $key = is_int($k) ? null : new Node\Scalar\String_((string)$k);
                $items[] = new Node\ArrayItem($this->literalToNode($v), $key);
            }
            return new Node\Expr\Array_($items);
        }
        return new Node\Expr\ConstFetch(new Node\Name('null'));
    }

    /**
     * Dispatch a pattern callee to its dedicated emitter.
     * $meta is stamped onto the emitted fact's payload.meta (merged, not replaced).
     * @param array<string, mixed> $meta
     */
    private function emitForCallee(string $callee, Node\Expr\FuncCall $call, array $meta): void
    {
        foreach (Patterns::$entries as $p) {
            $m = $p['match'] ?? null;
            if (!is_array($m)) continue;
            if (($m['lang'] ?? null) !== 'php') continue;
            if (($m['nodeKind'] ?? null) !== 'function-call') continue;
            if (($m['name'] ?? null) !== $callee) continue;

            $args = $this->extractArgs($call);
            $payload = ['kind' => $p['emit']];
            $this->unresolvedThisProps = [];
            foreach (($p['bind'] ?? []) as $field => $b) {
                $i = $b['arg'];
                $argNode = $args[$i] ?? null;
                $v = $this->readLiteral($argNode, $b['type']);
                if ($v !== null) $payload[$field] = $v;
            }

            $transform = $p['transform'] ?? null;
            if ($transform === 'rest-route') {
                $this->emitRestRouteFactsWithMeta($call, $payload, $meta);
                return;
            }
            if ($transform === 'enqueue-src') {
                $this->emitEnqueueScriptFactWithMeta($call, $payload, $meta);
                return;
            }
            // V1 synthesis supports rest-route and enqueue-src only. The other transforms
            // (admin-page-slug, block-render, localize-data) need bespoke synthesis logic
            // and have no wrapper test cases yet — emit nothing rather than a malformed
            // fact that silently pollutes the store.
            if ($transform !== null) return;
            // Plain anchor patterns (no transform): synthesize a fact with the anchor template.
            $anchors = [];
            $anchorRule = $p['anchor'] ?? null;
            if (is_array($anchorRule)) {
                $key = $this->renderAnchorKey($anchorRule['template'] ?? '', $payload);
                if ($key !== null) $anchors[] = ['key' => $key, 'role' => $anchorRule['role'] ?? 'subject'];
            }
            if ($meta !== []) $payload['meta'] = $meta;
            $this->facts[] = [
                'kind' => $p['emit'],
                'resolved' => true,
                'location' => $this->loc($call),
                'anchors' => $anchors,
                'payload' => $payload,
            ];
            return;
        }
    }

    /** @param array<string, mixed> $payload @param array<string, mixed> $meta */
    private function emitRestRouteFactsWithMeta(Node $n, array $payload, array $meta): void
    {
        // Run the standard emitRestRouteFacts path and then annotate the last-emitted facts.
        $countBefore = count($this->facts);
        $this->emitRestRouteFacts($n, $payload);
        // Stamp meta onto the facts that were just appended.
        if ($meta !== []) {
            for ($i = $countBefore; $i < count($this->facts); $i++) {
                $this->facts[$i]['payload']['meta'] = $meta;
            }
        }
    }

    /** @param array<string, mixed> $payload @param array<string, mixed> $meta */
    private function emitEnqueueScriptFactWithMeta(Node $n, array $payload, array $meta): void
    {
        $countBefore = count($this->facts);
        $this->emitEnqueueScriptFact($n, $payload);
        if ($meta !== []) {
            for ($i = $countBefore; $i < count($this->facts); $i++) {
                $this->facts[$i]['payload']['meta'] = $meta;
            }
        }
    }
}

$parser = (new ParserFactory)->createForNewestSupportedVersion();
// Persistent visitor — wrapperIndex and deferredWrapperCalls survive across
// extract ops so cross-file wrapper synthesis can work.
$visitor = new Visitor('', null, '');

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
        if (isset($req['wpPatternWrappers']) && is_array($req['wpPatternWrappers'])) {
            $visitor->seedConfigWrappers($req['wpPatternWrappers']);
        }
        emit(['op' => 'registered', 'count' => count(Patterns::$entries)]);
        continue;
    }
    if ($op === 'prepass') {
        $file = $req['file'] ?? '';
        $relFile = isset($req['relFile']) && is_string($req['relFile']) ? $req['relFile'] : null;
        if (!is_string($file) || !is_file($file)) {
            emit(['op' => 'prepass-ok']);
            continue;
        }
        try {
            $code = file_get_contents($file);
            if ($code === false) { emit(['op' => 'prepass-ok']); continue; }
            $ast = $parser->parse($code);
            if ($ast === null) { emit(['op' => 'prepass-ok']); continue; }
            $visitor->resetForFile($file, $relFile, $code);
            $visitor->buildWrapperIndexOnly($ast);
            emit(['op' => 'prepass-ok']);
        } catch (ParserError $e) {
            // A file that cannot be parsed contributes no wrappers. The phase-2
            // extract of the same file emits the parse-error fact as today.
            emit(['op' => 'prepass-ok']);
        } catch (\Throwable $t) {
            emit(['op' => 'error', 'message' => 'prepass failed: ' . $t->getMessage()]);
        }
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
            $wrapperIndexComplete = isset($req['wrapperIndexComplete']) && $req['wrapperIndexComplete'] === true;
            $visitor->resetForFile($file, $relFile, $code);
            $visitor->phpUnitBaseClasses = $req['phpUnitBaseClasses'] ?? ['PHPUnit\\Framework\\TestCase'];
            $visitor->setWrapperIndexComplete($wrapperIndexComplete);
            $visitor->prePass($ast);
            if ($wrapperIndexComplete) {
                // The index is complete — no deferral happens, so there is
                // nothing to replay. wrapperScopes must still be seeded so the
                // main traverse suppresses the wrapper-def body itself.
                $visitor->populateWrapperScopesFromCompleteIndex();
            } else {
                // Single-pass mode: eagerly drain stubs whose wrapper was just
                // found in this file's prePass.
                $visitor->earlyReplayAndBuffer();
            }
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
    if ($op === 'flush-deferred') {
        try {
            $facts = $visitor->replayDeferredCalls();
            emit([
                'op'           => 'facts',
                'facts'        => $facts,
                'wrapperIndex' => $visitor->dumpWrapperIndexForPersistence(),
            ]);
        } catch (\Throwable $t) {
            emit(['op' => 'error', 'message' => 'flush-deferred failed: ' . $t->getMessage()]);
        }
        continue;
    }
    if ($op === 'dump-wrapper-index') {
        emit(['op' => 'wrapper-index', 'entries' => $visitor->dumpWrapperIndexForMerge()]);
        continue;
    }
    if ($op === 'merge-wrapper-index') {
        $entries = is_array($req['entries'] ?? null) ? $req['entries'] : [];
        $count = $visitor->mergeWrapperIndexEntries($entries);
        emit(['op' => 'merged', 'count' => $count]);
        continue;
    }
    if ($op === 'reset-state') {
        // Preserve config-source wrappers across reset; drop auto-source ones.
        $keptWrappers = [];
        foreach ($visitor->getWrapperIndex() as $name => $entries) {
            $configEntries = array_values(array_filter($entries, fn($e) => ($e['source'] ?? 'auto') === 'config'));
            if ($configEntries !== []) $keptWrappers[$name] = $configEntries;
        }
        $visitor = new Visitor('', null, '');
        if ($keptWrappers !== []) {
            $visitor->setWrapperIndex($keptWrappers);
        }
        emit(['op' => 'reset-ok']);
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
